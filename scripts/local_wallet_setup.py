"""Opt-in development faucet: fixed local Anvil, fixed test assets and top-up targets."""

import threading

from check_monad_readiness import CheckError, quantity
from dashboard_data import DashboardRpc, hash32
from scan_arbitrage import address, abi

LOCAL_RPC = "http://127.0.0.1:18545"
MON_TARGET = 10 * 10**18
AUSD_TARGET = 10 * 10**6


class LocalSetupRpc(DashboardRpc):
    allowed_methods = DashboardRpc.allowed_methods | {"web3_clientVersion", "eth_accounts", "anvil_setBalance", "eth_sendTransaction"}

    def __init__(self):
        super().__init__(LOCAL_RPC)


class LocalWalletSetup:
    def __init__(self, factory):
        self.factory = factory
        self.lock = threading.Lock()
        self.uncertain = {}  # A transport failure never triggers an automatic resend.

    def __call__(self, wallet):
        wallet = address(wallet)
        if int(wallet, 16) == 0:
            raise CheckError("Choose a nonzero test wallet address")
        with self.lock:
            model = self.factory()
            rpc = model.rpc
            if rpc.url != LOCAL_RPC or model.m["environment"] != "local_fork":
                raise CheckError("Automatic funding is restricted to the local Anvil demo")
            version = rpc("web3_clientVersion", [])
            if not isinstance(version, str) or "anvil" not in version.lower():
                raise CheckError("Automatic funding requires an Anvil client")
            state = model.snapshot(wallet, [(128, 2)])  # Chain, checkpoint, code and asset checks before any write.
            if state["snapshot"]["stale"] or not state["trading_available"]:
                raise CheckError("Fresh, open local demo required; check the block helper")
            forbidden = {model.m[k] for k in ("pool", "cash", "receipt", "market", "margin", "executor", "operator")}
            if wallet in forbidden:
                raise CheckError("Choose a separate test account, not a demo contract or operator")
            accounts = [address(value) for value in rpc("eth_accounts", [])]
            if model.m["operator"] not in accounts:
                raise CheckError("Local demo operator is not unlocked; no funding sent")
            native = int(state["wallet"]["native_balance_wei"])
            balance = int(state["wallet"]["ausd_atoms"])
            missing = max(0, AUSD_TARGET - balance)
            if wallet in self.uncertain:
                if balance >= AUSD_TARGET:
                    del self.uncertain[wallet]
                else:
                    raise CheckError("Previous local funding is unresolved; inspect the local operator transaction before retrying")
            if missing and model.balance("cash", model.m["operator"]) < missing:
                raise CheckError("Local operator needs more test AUSD; no funding sent")
            tx_hash = None
            if native < MON_TARGET:
                rpc("anvil_setBalance", [wallet, hex(MON_TARGET)])
            if missing:
                self.uncertain[wallet] = True
                tx_hash = hash32(rpc("eth_sendTransaction", [{"from": model.m["operator"], "to": model.m["cash"],
                                     "data": abi("a9059cbb", int(wallet, 16), missing), "value": "0x0"}]))
                receipt = rpc("eth_getTransactionReceipt", [tx_hash])
                if not receipt or hash32(receipt.get("transactionHash")) != tx_hash:
                    raise CheckError("Local funding receipt unavailable; inspect before retrying")
                block = rpc("eth_getBlockByNumber", [receipt["blockNumber"], False])
                if hash32(block.get("hash")) != hash32(receipt.get("blockHash")):
                    raise CheckError("Local funding receipt changed; inspect before retrying")
                if quantity(receipt.get("status")) != 1:
                    del self.uncertain[wallet]
                    raise CheckError("Local test AUSD transfer reverted")
            # Read balances directly at latest: an empty block is not needed for anvil_setBalance.
            observed_cash = int(rpc("eth_call", [{"to": model.m["cash"], "data": abi("70a08231", int(wallet, 16))}, "latest"]), 16)
            observed_native = quantity(rpc("eth_getBalance", [wallet, "latest"]))
            if observed_cash < AUSD_TARGET or observed_native < MON_TARGET:
                raise CheckError("Local top-up incomplete; inspect balances before retrying")
            self.uncertain.pop(wallet, None)
            return {"environment": "local_fork", "wallet": wallet, "ausd_atoms": str(observed_cash),
                    "native_balance_wei": str(observed_native), "funding_hash": tx_hash,
                    "ausd_added_atoms": str(missing), "native_topped_up": native < MON_TARGET}
