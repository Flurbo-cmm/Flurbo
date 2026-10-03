"""Read-only dashboard model. Amounts are decimal strings safe for JavaScript BigInt."""

import hashlib
import json
import re
import time
import threading
from collections import deque
from urllib.parse import urlsplit
from urllib.request import Request

from check_monad_readiness import CheckError, Rpc, quantity
from check_kuru_readiness import words
from scan_arbitrage import abi, address, block_info
from verify_demo import RULES, RULES_HASH

TRADED = "0xfafd4a382ead0cb54fe827af5995137a1a8b433ebfd5a8d13def35a83adfb9b5"
TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
APPROVAL = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925"
REDEEMED = "0x3e24bbc5ae535f3f571a815b8ba9fc70c94ad494d812f0210c3da99fad2173ae"
WRAPPED = "0x1678e1ca0a6fe8c67ed99c47dfc6bfbd624dde9b4ea6888c388819b92bdcf9af"
UNWRAPPED = "0x3cba585a603da842c7ea575bdf8506be18538491b5751a625b119ca1432d5db3"


def wins(scope, mask, outcome):
    projected = 0
    bit = 0
    for event in range(8):
        if scope & (1 << event):
            projected |= ((outcome >> event) & 1) << bit
            bit += 1
    return bool(mask & (1 << projected))


class DashboardRpc(Rpc):
    allowed_methods = Rpc.allowed_methods | {"eth_getBalance", "eth_getTransactionByHash", "eth_getTransactionReceipt", "eth_getLogs"}
    _public_lock = threading.Lock()
    _public_reads = deque()

    def pace(self, count):
        # The public endpoint enforces 15 reads/sec even inside JSON-RPC batches.
        # Share a conservative budget between HTTP handlers; private RPCs have
        # their own provider quotas and do not use this public-endpoint limiter.
        if urlsplit(self.url).hostname != "testnet-rpc.monad.xyz":
            return
        with self._public_lock:
            while True:
                now = time.monotonic()
                while self._public_reads and now - self._public_reads[0] >= 1.1:
                    self._public_reads.popleft()
                if len(self._public_reads) + count <= 12:
                    self._public_reads.extend([now] * count)
                    return
                time.sleep(max(0.001, 1.1 - (now - self._public_reads[0])))

    def __init__(self, url):
        super().__init__(url)
        self.prefetched = {}

    @staticmethod
    def cache_key(method, params):
        return json.dumps([method, params], sort_keys=True)

    def __call__(self, method, params):
        key = self.cache_key(method, params)
        if key in self.prefetched:
            return self.prefetched[key]
        self.pace(1)
        return super().__call__(method, params)

    def prefetch(self, calls):
        # Only block-pinned reads may be reused inside this one HTTP request.
        # Checkpoints, latest heads and the final reorg check always hit the RPC.
        if not 1 <= len(calls) <= 32:
            raise CheckError("Invalid dashboard batch size")
        payload, keys = [], {}
        for method, params in calls:
            if method not in {"eth_call", "eth_getCode", "eth_getBalance"} or not params or not re.fullmatch(r"0x[0-9a-fA-F]+", str(params[-1])):
                raise CheckError("Only block-pinned dashboard reads may be batched")
            self.counter += 1
            keys[self.counter] = self.cache_key(method, params)
            payload.append({"jsonrpc": "2.0", "id": self.counter, "method": method, "params": params})
        values = {}
        for start in range(0, len(payload), 10):
            chunk = payload[start:start + 10]
            self.pace(len(chunk))
            values.update(self.read_batch(chunk, {item["id"]: keys[item["id"]] for item in chunk}))
        self.prefetched.update(values)  # Never accept a partially valid prefetch.

    def read_batch(self, payload, keys):
        request = Request(self.url, json.dumps(payload).encode(), {"Content-Type": "application/json"})
        try:
            with self.opener.open(request, timeout=15) as response:
                raw = response.read(2_000_001)
            if len(raw) > 2_000_000:
                raise CheckError("Dashboard batch exceeded size limit")
            results = json.loads(raw)
        except CheckError:
            raise
        except Exception:
            raise CheckError("Dashboard batch transport or JSON failure; remote details withheld") from None
        if not isinstance(results, list) or len(results) != len(payload):
            raise CheckError("Invalid dashboard batch response")
        received, values = set(), {}
        for item in results:
            if (not isinstance(item, dict) or item.get("jsonrpc") != "2.0" or type(item.get("id")) is not int
                    or item["id"] not in keys or item["id"] in received or "error" in item or "result" not in item):
                raise CheckError("Dashboard batch rejected or mismatched; remote details withheld")
            received.add(item["id"])
            values[keys[item["id"]]] = item["result"]
        return values


def claim(scope, mask):
    if type(scope) is not int or not 0 < scope < 256 or not 1 <= scope.bit_count() <= 3:
        raise ValueError("Select one to three events from this eight-event cluster")
    full = (1 << (1 << scope.bit_count())) - 1
    if type(mask) is not int or not 0 < mask < full:
        raise ValueError("Payoff mask must be nonconstant and fit the selected events")
    return scope, mask


def hash32(value):
    if not isinstance(value, str) or not re.fullmatch(r"0x[0-9a-fA-F]{64}", value):
        raise ValueError("Expected a 32-byte transaction/block hash")
    return value.lower()


class Dashboard:
    def __init__(self, manifest, network, rpc, environment, clock=time.time):
        self.m = dict(manifest)
        self.rpc, self.clock = rpc, clock
        m = self.m
        if m.get("status") != "verified_snapshot" or m.get("manifest_version") != 1:
            raise CheckError("Dashboard requires a verified deployment manifest")
        if m.get("environment") != environment or m.get("chain_id") != 10143:
            raise CheckError("Manifest environment differs from selected RPC")
        for key in ("pool", "receipt", "market", "executor", "cash", "margin", "operator", "resolver"):
            m[key] = address(m.get(key))
        if m["cash"] != address(network["contracts"]["ausd"]) or m["margin"] != address(network["contracts"]["kuru_margin"]):
            raise CheckError("Unexpected network assets")
        if m.get("rules_hash") != RULES_HASH or m.get("rules") != RULES:
            raise CheckError("Unsupported synthetic settlement rules")
        if (m.get("scope"), m.get("mask"), m.get("event_count"), m.get("liquidity_atoms")) != (128, 2, 8, 10000000):
            raise CheckError("Unsupported demo manifest")

    def begin(self):
        m = self.m
        if isinstance(self.rpc, DashboardRpc):
            self.rpc.prefetched.clear()
        if quantity(self.rpc("eth_chainId", [])) != 10143:
            raise CheckError("Wrong RPC chain")
        baseline = self.rpc("eth_getBlockByNumber", [hex(m["verified_block"]), False])
        if block_info(baseline)[2] != hash32(m["verified_block_hash"]):
            raise CheckError("Deployment checkpoint changed; verify the manifest again")
        self.number, self.timestamp, self.block_hash = block_info(self.rpc("eth_getBlockByNumber", ["latest", False]))
        self.tag = hex(self.number)
        self.prefetch(
            [("eth_getCode", [m[key], self.tag]) for key in ("pool", "receipt", "market", "executor", "cash", "margin")]
            + [self.read_call("pool", sig) for sig in ("71be2e4a", "1a686502", "ec9c6c30", "04f3bcec", "03a79426", "39a3a99a", "d8dfeb45", "f3a504f2", "3f6fa655", "b53105a3")]
            + [self.read_call("pool", "7220c660", 128, 2), self.read_call("market", "90c9427c"),
               self.read_call("cash", "70a08231", int(m["pool"], 16)), self.read_call("receipt", "18160ddd"),
               self.read_call("pool", "90fc2c7b", int(m["receipt"], 16), 128, 2),
               self.read_call("cash", "70a08231", int(m["executor"], 16))])
        for key in ("pool", "receipt", "market", "executor", "cash", "margin"):
            code = self.rpc("eth_getCode", [m[key], self.tag])
            if not isinstance(code, str) or not re.fullmatch(r"0x(?:[0-9a-fA-F]{2})+", code):
                raise CheckError("Deployed contract code is unavailable")
            if hashlib.sha256(bytes.fromhex(code[2:])).hexdigest() != m["code_sha256"].get(key):
                raise CheckError("Deployed contract code changed; verify the manifest again")
        expected = {"71be2e4a": 8, "1a686502": 10000000, "ec9c6c30": 6,
                    "04f3bcec": int(m["resolver"], 16), "03a79426": int(RULES_HASH, 16),
                    "39a3a99a": m["closes_at"], "d8dfeb45": int(m["cash"], 16)}
        if any(self.call("pool", sig)[0] != value for sig, value in expected.items()):
            raise CheckError("Pool configuration differs from verified manifest")
        if self.call("pool", "7220c660", 128, 2)[0] != int(m["receipt"], 16):
            raise CheckError("Receipt registry changed")
        pair = self.call("market", "90c9427c", count=11)
        if pair != [1000000, 1000000, int(m["receipt"], 16), 6, int(m["cash"], 16), 6, 100, 10000, 100000000, 30, 10]:
            raise CheckError("Kuru pair configuration changed")

    def call(self, key, selector, *args, count=1):
        return words(self.rpc("eth_call", [{"to": self.m[key], "data": abi(selector, *args)}, self.tag]), count)

    def read_call(self, key, selector, *args):
        return ("eth_call", [{"to": self.m[key], "data": abi(selector, *args)}, self.tag])

    def prefetch(self, calls):
        if isinstance(self.rpc, DashboardRpc):
            self.rpc.prefetch(calls)

    def balance(self, asset, owner):
        return self.call(asset, "70a08231", int(owner, 16))[0]

    def state(self):
        funded = self.call("pool", "f3a504f2")[0]
        resolved = self.call("pool", "3f6fa655")[0]
        if funded not in (0, 1) or resolved not in (0, 1):
            raise CheckError("Malformed pool state")
        outcome = self.call("pool", "1bb51c6a")[0] if resolved else None
        if outcome is not None and outcome >= 256:
            raise CheckError("Resolved state is outside the cluster")
        balance = self.balance("cash", self.m["pool"])
        required = self.call("pool", "b53105a3")[0]
        supply = self.call("receipt", "18160ddd")[0]
        escrow = self.call("pool", "90fc2c7b", int(self.m["receipt"], 16), 128, 2)[0]
        covered = balance >= required
        backed = supply == escrow
        phase = "resolved" if resolved else "closed" if self.timestamp >= self.m["closes_at"] else "open" if funded else "unfunded"
        return {"phase": phase, "funded": bool(funded), "resolved": bool(resolved), "resolved_state": outcome, "covered": covered, "receipt_backed": backed,
                "pool_collateral_atoms": str(balance), "required_collateral_atoms": str(required),
                "coverage_surplus_atoms": str(balance - required), "receipt_supply_atoms": str(supply),
                "receipt_escrow_atoms": str(escrow), "executor_collateral_atoms": str(self.balance("cash", self.m["executor"]))}

    def finish(self, payload):
        if block_info(self.rpc("eth_getBlockByNumber", [self.tag, False])) != (self.number, self.timestamp, self.block_hash):
            raise CheckError("Snapshot reorganized; retry")
        head, _, _ = block_info(self.rpc("eth_getBlockByNumber", ["latest", False]))
        age = int(self.clock()) - self.timestamp
        stale = not 0 <= age <= 30 or (head < self.number or (self.m["environment"] == "local_fork" and head > self.number + 2))
        payload.update(read_only=True, environment=self.m["environment"], chain_id=10143,
                       snapshot={"block_number": self.number, "block_hash": self.block_hash,
                                 "timestamp": self.timestamp, "age_seconds": age, "stale": stale})
        expired = payload.get("quote") is not None and int(self.clock()) >= payload["quote"]["valid_until"]
        if (stale or expired) and "quote" in payload:
            payload["quote"] = None
            payload["quote_status"] = "unavailable"
            payload["reason"] = "Snapshot or quote window expired; refresh before requesting a quote"
        return payload

    def snapshot(self, wallet=None, claims=None):
        if wallet is not None:
            try:
                wallet = address(wallet)
            except CheckError:
                raise ValueError("Invalid wallet address") from None
        claims = [(1 << i, side) for i in range(8) for side in (1, 2)] if claims is None else claims
        if not isinstance(claims, list) or not 1 <= len(claims) <= 16:
            raise ValueError("Request 1–16 claim balances")
        claims = list(dict.fromkeys(claim(*item) for item in claims))
        self.begin()
        reads = [self.read_call("market", "b4de8b70")]
        if wallet:
            w = int(wallet, 16)
            reads += [("eth_getBalance", [wallet, self.tag]), self.read_call("cash", "70a08231", w),
                      self.read_call("receipt", "70a08231", w), self.read_call("cash", "dd62ed3e", w, int(self.m["pool"], 16)),
                      self.read_call("margin", "d4fac45d", w, int(self.m["cash"], 16)),
                      self.read_call("margin", "d4fac45d", w, int(self.m["receipt"], 16))]
            reads += [self.read_call("pool", "90fc2c7b", w, s, p) for s, p in claims]
        self.prefetch(reads)
        state = self.state()
        bid, ask = self.call("market", "b4de8b70", count=2)
        result = {"cluster": {"events": [{"index": i, "label": f"Synthetic event {chr(65+i)}"} for i in range(8)],
                              "rules": RULES, "closes_at": self.m["closes_at"], "liquidity_atoms": "10000000",
                              "collateral_decimals": 6, "collateral_symbol": "AUSD", "resolver": self.m["resolver"]},
                  "contracts": {key: self.m[key] for key in ("pool", "receipt", "market", "cash", "margin", "executor")},
                  "pool": state, "wallet": None,
                  "kuru": {"best_bid_wad": None if bid == 2**256 - 1 else str(bid),
                           "best_ask_wad": None if ask == 0 else str(ask),
                           "price_scale": str(10**18), "quote_type": "indicative_top_of_book_not_execution"}}
        if wallet:
            w = int(wallet, 16)
            result["wallet"] = {"address": wallet, "native_balance_wei": str(quantity(self.rpc("eth_getBalance", [wallet, self.tag]))),
                                "ausd_atoms": str(self.balance("cash", wallet)), "receipt_atoms": str(self.balance("receipt", wallet)),
                                "pool_allowance_atoms": str(self.call("cash", "dd62ed3e", w, int(self.m["pool"], 16))[0]),
                                "margin_available_ausd_atoms": str(self.call("margin", "d4fac45d", w, int(self.m["cash"], 16))[0]),
                                "margin_available_receipt_atoms": str(self.call("margin", "d4fac45d", w, int(self.m["receipt"], 16))[0]),
                                "positions_scope": "requested_claims_only",
                                "positions": [{"scope": s, "mask": p, "quantity_atoms": str(self.call("pool", "90fc2c7b", w, s, p)[0])} for s, p in claims]}
            for position in result["wallet"]["positions"]:
                winner = wins(position["scope"], position["mask"], state["resolved_state"]) if state["resolved"] else None
                position.update(settlement="pending" if winner is None else "winning" if winner else "losing",
                                redeemable_atoms=None if winner is None else position["quantity_atoms"] if winner else "0")
        result = self.finish(result)
        result["trading_available"] = (state["phase"] == "open" and state["covered"] and state["receipt_backed"]
                                       and not result["snapshot"]["stale"] and int(self.clock()) < self.m["closes_at"])
        result["redemption_available"] = bool(state["resolved"] and state["covered"] and state["receipt_backed"] and not result["snapshot"]["stale"])
        # Conversion moves ownership, never collateral. It can remain available after resolution or shortfall.
        result["conversion_available"] = bool(state["receipt_backed"] and not result["snapshot"]["stale"])
        return result

    def quote(self, side, scope, mask, amount):
        scope, mask = claim(scope, mask)
        if side not in ("buy", "sell") or type(amount) is not int or not 0 < amount < 2**128:
            raise ValueError("Provide buy/sell and a positive uint128 quantity in collateral atoms")
        self.begin()
        state = self.state()
        result = {"quote": None, "quote_status": "unavailable"}
        if state["phase"] != "open" or not state["covered"] or not state["receipt_backed"]:
            result["reason"] = "Pool is not open and fully backed for trading"
        elif not 0 <= int(self.clock()) - self.timestamp <= 30:
            result["reason"] = "Snapshot is stale"
        else:
            try:
                value = self.call("pool", "a6a83dde" if side == "buy" else "f29d0ba9", scope, mask, amount)[0]
                if not 0 < value <= amount:
                    raise CheckError("Quote exceeds supported payoff bounds")
                result.update(quote_status="available", quote={"side": side, "scope": scope, "mask": mask,
                              "quantity_atoms": str(amount), "collateral_atoms": str(value),
                              "valid_until": min(self.timestamp + 300, self.m["closes_at"] - 1),
                              "requires_execution_recheck": True, "ownership_checked": False})
            except CheckError:
                result["reason"] = "Pool quote unavailable or rejected; no fallback price is supplied"
        return self.finish(result)

    def transaction(self, tx_hash):
        tx_hash = hash32(tx_hash)
        self.begin()
        receipt = self.rpc("eth_getTransactionReceipt", [tx_hash])
        tx = self.rpc("eth_getTransactionByHash", [tx_hash])
        result = {"transaction": {"hash": tx_hash, "status": "unknown", "confirmations": 0}}
        item = result["transaction"]
        if tx is not None:
            if not isinstance(tx, dict) or hash32(tx.get("hash")) != tx_hash:
                raise CheckError("Transaction response mismatch")
            item.update(status="pending" if tx.get("blockNumber") is None else "awaiting_receipt",
                        sender=address(tx["from"]), to=address(tx["to"]) if tx.get("to") else None)
            tx_input = tx.get("input", "0x")
            if not isinstance(tx_input, str) or not re.fullmatch(r"0x(?:[0-9a-fA-F]{2}){0,32768}", tx_input):
                raise CheckError("Malformed transaction input")
            item.update(input=tx_input.lower(), value_wei=str(quantity(tx.get("value", "0x0"))))
            item["targets_demo"] = item["to"] in [self.m[k] for k in ("pool", "receipt", "market", "cash", "margin", "executor") if k in self.m]
        if receipt is not None:
            if not isinstance(receipt, dict) or hash32(receipt.get("transactionHash")) != tx_hash:
                raise CheckError("Receipt response mismatch")
            block = quantity(receipt.get("blockNumber"))
            canonical = block_info(self.rpc("eth_getBlockByNumber", [hex(block), False]))[2]
            if canonical != hash32(receipt.get("blockHash")) or block > self.number:
                raise CheckError("Receipt is outside the pinned canonical snapshot; retry")
            status = quantity(receipt.get("status"))
            if status not in (0, 1):
                raise CheckError("Invalid transaction status")
            item.update(status="succeeded" if status else "reverted", confirmations=self.number - block + 1,
                        block_number=block, gas_used=str(quantity(receipt.get("gasUsed"))))
            item["events"] = self.receipt_events(receipt, tx_hash)
        return self.finish(result)

    def receipt_events(self, receipt, tx_hash):
        result = []
        for log in receipt.get("logs", []):
            origin = address(log.get("address"))
            topics = log.get("topics", [])
            if not topics or (origin, topics[0]) not in ((self.m["pool"], TRADED), (self.m["pool"], REDEEMED), (self.m["pool"], WRAPPED), (self.m["pool"], UNWRAPPED), (self.m["cash"], APPROVAL), (self.m["cash"], TRANSFER)):
                continue
            if log.get("removed") or hash32(log.get("blockHash")) != hash32(receipt["blockHash"]) or hash32(log.get("transactionHash")) != tx_hash:
                raise CheckError("Event is outside the canonical transaction receipt")
            indexed = [int(hash32(topic), 16) for topic in topics[1:]]
            if topics[0] == TRADED:
                values = words(log.get("data"), 3)
                if len(indexed) != 3 or indexed[0] >= 2**160 or indexed[1] >= 2**32 or values[0] not in (0, 1) or max(values[1:]) >= 2**128:
                    raise CheckError("Malformed trade event")
                result.append({"kind": "trade", "trader": f"0x{indexed[0]:040x}", "scope": indexed[1],
                               "mask": str(indexed[2]), "is_buy": bool(values[0]), "quantity_atoms": str(values[1]),
                               "collateral_atoms": str(values[2])})
            elif topics[0] == REDEEMED:
                values = words(log.get("data"), 2)
                if len(indexed) != 3 or indexed[0] >= 2**160 or indexed[1] >= 2**32 or max(values) >= 2**128:
                    raise CheckError("Malformed redemption event")
                claim(indexed[1], indexed[2])
                if values[0] == 0 or values[1] not in (0, values[0]):
                    raise CheckError("Unexpected redemption payout")
                result.append({"kind": "redemption", "owner": f"0x{indexed[0]:040x}", "scope": indexed[1],
                               "mask": str(indexed[2]), "quantity_atoms": str(values[0]), "collateral_atoms": str(values[1])})
            elif topics[0] in (WRAPPED, UNWRAPPED):
                values = words(log.get("data"), 1)
                if len(indexed) != 3 or indexed[0] >= 2**160 or not 0 < indexed[1] < 256 or indexed[1].bit_count() != 1 or indexed[2] not in (1, 2) or not 0 < values[0] < 2**128:
                    raise CheckError("Malformed base conversion event")
                result.append({"kind": "wrap" if topics[0] == WRAPPED else "unwrap", "owner": f"0x{indexed[0]:040x}",
                               "scope": indexed[1], "mask": str(indexed[2]), "quantity_atoms": str(values[0])})
            else:
                values = words(log.get("data"), 1)
                if len(indexed) != 2 or max(indexed) >= 2**160:
                    raise CheckError("Malformed token event")
                result.append({"kind": "transfer" if topics[0] == TRANSFER else "approval", "owner": f"0x{indexed[0]:040x}",
                               ("recipient" if topics[0] == TRANSFER else "spender"): f"0x{indexed[1]:040x}", "amount_atoms": str(values[0])})
        return result
