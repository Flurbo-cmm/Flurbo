"""Chain reads on the operator's own RPC. Prices are only the pool's quoteBuy / quoteSell at a pinned block."""
from ..abi import decode_words, encode_call
from ..errors import FlurboError
from ..protocol import COLLATERAL, COLLATERAL_DECIMALS
from .rpc import RpcError
from .signer import keccak_hex


class ChainReader:
    def __init__(self, rpc):
        self.rpc = rpc

    def _word(self, to: str, data: str, tag: str = "latest") -> int:
        return decode_words(str(self.rpc("eth_call", [{"to": to, "data": data}, tag])), 1)[0]

    def block(self, tag: str | int = "latest") -> dict:
        b = self.rpc("eth_getBlockByNumber", [hex(tag) if isinstance(tag, int) else tag, False])
        if not b or not b.get("hash") or not b.get("number"):
            raise FlurboError("invalid_response", "The chain returned no block.")
        return {"number": int(b["number"], 16), "hash": b["hash"].lower(), "timestamp": int(b["timestamp"], 16)}

    def chain_id(self) -> int:
        return int(self.rpc("eth_chainId", []), 16)

    def verify_deployment(self, d: dict) -> None:
        """protocol/specs/contracts.md: every check before trading on a deployment."""
        def fail(what: str):
            raise FlurboError("invalid_response", f"Unsupported deployment {d['namespace']}: {what}.")
        if self.chain_id() != 10143:
            fail("the RPC is not Monad testnet (10143)")
        head = hex(self.block()["number"])
        for address, expected in ((d["pool"], d["codeHashes"]["pool"]), (d["resolver"], d["codeHashes"]["resolver"])):
            code = str(self.rpc("eth_getCode", [address, head]))
            if code == "0x" or keccak_hex(code) != expected:
                fail("contract code differs from the published deployment")
        if "0x" + format(self._word(d["pool"], encode_call("settlementRulesHash", []), head), "064x") != d["rulesHash"]:
            fail("settlement rules differ")
        if self._word(d["pool"], encode_call("closesAt", []), head) != d["closesAt"]:
            fail("close time differs")
        if self._word(d["pool"], encode_call("eventCount", []), head) != d["eventCount"]:
            fail("event count differs")
        if "0x" + format(self._word(d["pool"], encode_call("collateral", []), head), "040x") != COLLATERAL:
            fail("collateral differs")
        if self._word(COLLATERAL, encode_call("decimals", []), head) != COLLATERAL_DECIMALS:
            fail("collateral decimals differ")

    def quote(self, pool: str, side: str, scope: int, mask: int, quantity: int, at: dict) -> int | None:
        try:
            return self._word(pool, encode_call("quoteBuy" if side == "buy" else "quoteSell", [scope, mask, quantity]), hex(at["number"]))
        except RpcError as e:
            if e.kind == "rejected":
                return None
            raise

    def resolved(self, pool: str) -> bool:
        return self._word(pool, encode_call("resolved", [])) == 1

    def holdings(self, pool: str, owner: str, scope: int, mask: int) -> int:
        return self._word(pool, encode_call("holdings", [owner, scope, mask]))

    def allowance(self, owner: str, spender: str, tag: str = "latest") -> int:
        return self._word(COLLATERAL, encode_call("allowance", [owner, spender]), tag)

    def native_balance(self, owner: str) -> int:
        return int(self.rpc("eth_getBalance", [owner, "latest"]), 16)

    def nonce(self, owner: str, tag: str) -> int:
        return int(self.rpc("eth_getTransactionCount", [owner, tag]), 16)

    def simulate(self, sender: str, to: str, data: str):
        return self.rpc("eth_call", [{"from": sender, "to": to, "data": data, "value": "0x0"}, "latest"])

    def estimate_gas(self, sender: str, to: str, data: str) -> int:
        return int(self.rpc("eth_estimateGas", [{"from": sender, "to": to, "data": data, "value": "0x0"}]), 16)

    def fees(self) -> dict:
        price = int(self.rpc("eth_gasPrice", []), 16)
        try:
            priority = int(self.rpc("eth_maxPriorityFeePerGas", []), 16)
        except RpcError:
            priority = 0
        max_fee = price * 120 // 100
        return {"maxFeePerGas": max_fee, "maxPriorityFeePerGas": min(priority, max_fee)}

    def send_raw(self, raw: str):
        return self.rpc("eth_sendRawTransaction", [raw])

    def transaction(self, tx_hash: str):
        return self.rpc("eth_getTransactionByHash", [tx_hash])

    def receipt(self, tx_hash: str) -> dict | None:
        r = self.rpc("eth_getTransactionReceipt", [tx_hash])
        if not r:
            return None
        return {"status": 1 if int(r["status"], 16) == 1 else 0, "blockNumber": int(r["blockNumber"], 16), "blockHash": r["blockHash"].lower(),
                "gasUsed": int(r.get("gasUsed") or "0x0", 16), "effectiveGasPrice": int(r["effectiveGasPrice"], 16) if r.get("effectiveGasPrice") else None,
                "logs": [{"address": str(l.get("address", "")).lower(), "topics": [str(t).lower() for t in l.get("topics") or []], "data": str(l.get("data"))} for l in r.get("logs") or []]}
