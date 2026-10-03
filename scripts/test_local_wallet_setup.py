import io
import json
from types import SimpleNamespace
import unittest

from check_monad_readiness import CheckError
from local_wallet_setup import LocalWalletSetup, LOCAL_RPC, MON_TARGET, AUSD_TARGET
from scan_arbitrage import abi
from serve_dashboard import handler
from test_dashboard_data import setup

WALLET = "0x" + "99" * 20
TX = "0x" + "dd" * 32


def faucet():
    model, reads, manifest = setup()
    class Rpc:
        url = LOCAL_RPC
        native = 0
        cash = 0
        version = "anvil/v1"
        uncertain = False
        writes = []
        def __call__(self, method, params):
            if method == "web3_clientVersion": return self.version
            if method == "eth_accounts": return [manifest["operator"]]
            if method == "eth_getBalance": return hex(self.native)
            if method == "eth_call" and params[0]["to"] == manifest["cash"] and params[0]["data"] == abi("70a08231", int(WALLET, 16)):
                return abi("", self.cash)
            if method == "anvil_setBalance":
                self.writes.append((method, params)); self.native = int(params[1], 16); return True
            if method == "eth_sendTransaction":
                self.writes.append((method, params))
                if self.uncertain: raise CheckError("Uncertain transport")
                self.cash += int(params[0]["data"][-64:], 16); return TX
            if method == "eth_getTransactionReceipt":
                return {"transactionHash": TX, "blockNumber": "0x64", "blockHash": "0x" + "aa" * 32, "status": "0x1"}
            return reads(method, params)
    rpc = Rpc(); rpc.writes = []; model.rpc = rpc
    return LocalWalletSetup(lambda: model), rpc, model


class FundingTests(unittest.TestCase):
    def test_top_up_is_capped_and_repeat_does_not_send_or_reduce_existing_balances(self):
        fund, rpc, model = faucet()
        rpc.cash = 3000000
        result = fund(WALLET)
        self.assertEqual(result["ausd_added_atoms"], "7000000")
        self.assertEqual(rpc.native, MON_TARGET)
        self.assertEqual(rpc.cash, AUSD_TARGET)
        tx = rpc.writes[1][1][0]
        self.assertEqual(tx["to"], model.m["cash"])
        self.assertEqual(tx["from"], model.m["operator"])
        self.assertEqual(tx["data"], abi("a9059cbb", int(WALLET, 16), 7000000))
        rpc.native = 2 * MON_TARGET; rpc.cash = 2 * AUSD_TARGET
        self.assertIsNone(fund(WALLET)["funding_hash"])
        self.assertEqual(len(rpc.writes), 2)
        self.assertEqual(rpc.native, 2 * MON_TARGET)

    def test_wrong_rpc_client_environment_stale_or_checkpoint_cannot_write(self):
        for change in (lambda r, m: setattr(r, "url", "https://example.org"), lambda r, m: setattr(r, "version", "geth"),
                       lambda r, m: m.m.update(environment="public_testnet"), lambda r, m: m.m.update(verified_block_hash="0x" + "bb" * 32),
                       lambda r, m: setattr(m, "clock", lambda: 2000)):
            fund, rpc, model = faucet(); change(rpc, model)
            with self.assertRaises(CheckError): fund(WALLET)
            self.assertEqual(rpc.writes, [])

    def test_uncertain_transfer_is_not_automatically_repeated(self):
        fund, rpc, _ = faucet(); rpc.uncertain = True
        with self.assertRaises(CheckError): fund(WALLET)
        with self.assertRaisesRegex(CheckError, "unresolved"): fund(WALLET)
        self.assertEqual(sum(method == "eth_sendTransaction" for method, _ in rpc.writes), 1)

    def test_contracts_and_zero_account_cannot_receive_topups(self):
        fund, rpc, model = faucet()
        for wallet in (model.m["pool"], model.m["operator"], "0x" + "00" * 20):
            with self.assertRaises(CheckError): fund(wallet)
        self.assertEqual(rpc.writes, [])


class PostTests(unittest.TestCase):
    def post(self, enabled=True, **changes):
        calls = []
        cls = handler(lambda: None, (lambda wallet: calls.append(wallet) or {"ok": True}) if enabled else None)
        h = cls.__new__(cls)
        body = changes.pop("body", {"wallet": WALLET})
        raw = json.dumps(body).encode()
        h.path = changes.pop("path", "/api/local-wallet-setup")
        h.headers = {"Host": "localhost:18765", "Origin": "http://localhost:18765", "Content-Type": "application/json", "Content-Length": str(len(raw)), **changes}
        h.server = SimpleNamespace(server_port=18765); h.connection = SimpleNamespace(settimeout=lambda n: None)
        h.rfile = io.BytesIO(raw); h.wfile = io.BytesIO()
        result = {}
        h.send_response = lambda status: result.update(status=status)
        h.send_header = lambda *args: None; h.end_headers = lambda: None
        h.do_POST()
        return result["status"], calls

    def test_faucet_requires_explicit_enable_and_exact_origin_and_fixed_body(self):
        self.assertEqual(self.post(), (200, [WALLET]))
        for options, code in (({"enabled": False}, 405), ({"Origin": None}, 403), ({"Origin": "https://evil.example"}, 403),
                              ({"Origin": "http://127.0.0.1:18765"}, 403), ({"Content-Type": "text/plain"}, 400),
                              ({"Content-Length": "9999"}, 400), ({"body": {"wallet": WALLET, "amount": "999"}}, 400),
                              ({"path": "/api/send"}, 405)):
            self.assertEqual(self.post(**options), (code, []))


if __name__ == "__main__": unittest.main()
