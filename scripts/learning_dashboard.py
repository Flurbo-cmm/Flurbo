"""Public learning-market reader. Reuses claim/receipt checks, never the Kuru deployment."""
import hashlib
import re
import time

from check_monad_readiness import CheckError, quantity
from dashboard_data import Dashboard, DashboardRpc, claim, hash32, wins
from scan_arbitrage import address, block_info
from verify_learning_deployment import PLAN, RULES, RULES_HASH, OPERATOR, AUSD

POOL = "0x094ed5f95188c222a61c27cae24b068120a52dd4"


class LearningDashboard(Dashboard):
    def __init__(self, manifest, network, rpc, environment, clock=time.time):
        m = self.m = dict(manifest)
        self.rpc, self.clock = rpc, clock
        if (environment != "public_testnet" or m.get("environment") != environment
                or m.get("status") != "verified_learning_snapshot" or m.get("manifest_version") != 1
                or m.get("chain_id") != 10143 or m.get("pool") != POOL
                or m.get("cash") != AUSD or address(network["contracts"]["ausd"]) != AUSD
                or any(m.get(k) != OPERATOR for k in ("updater", "operator", "resolver"))
                or m.get("rules") != RULES or m.get("rules_hash") != RULES_HASH
                or any(m.get(k) != v for k, v in PLAN.items())):
            raise CheckError("Unverified public learning market")
        for key in ("pool", "cash", "pricing_engine", "base_token_factory"):
            address(m.get(key))
        for key in ("pool", "pricing_engine", "base_token_factory"):
            if not re.fullmatch(r"[0-9a-f]{64}", m.get("runtime_evidence", {}).get(key, {}).get("runtime_sha256", "")):
                raise CheckError("Missing runtime evidence")
        if not re.fullmatch(r"[0-9a-f]{64}", m.get("cash_proxy_sha256", "")):
            raise CheckError("Missing collateral evidence")
        hash32(m.get("verified_block_hash"))
        if type(m.get("verified_block")) is not int or m["verified_block"] < 0 or type(m.get("closes_at")) is not int:
            raise CheckError("Missing deployment checkpoint")

    def begin(self):
        m = self.m
        if isinstance(self.rpc, DashboardRpc):
            self.rpc.prefetched.clear()
        if quantity(self.rpc("eth_chainId", [])) != 10143:
            raise CheckError("Wrong RPC chain")
        if block_info(self.rpc("eth_getBlockByNumber", [hex(m["verified_block"]), False]))[2] != m["verified_block_hash"]:
            raise CheckError("Learning deployment checkpoint changed")
        self.number, self.timestamp, self.block_hash = block_info(self.rpc("eth_getBlockByNumber", ["latest", False]))
        self.tag = hex(self.number)
        contracts = ("pool", "pricing_engine", "base_token_factory", "cash")
        self.prefetch([("eth_getCode", [m[k], self.tag]) for k in contracts]
                      + [self.read_call("pool", sig) for sig in ("f3a504f2", "3f6fa655", "b53105a3", "a88db792", "0019984b", "7cc96380", "69b4ecc9")]
                      + [self.read_call("cash", "70a08231", int(m["pool"], 16))])
        for key in contracts:
            code = self.rpc("eth_getCode", [m[key], self.tag])
            expected = m["cash_proxy_sha256"] if key == "cash" else m["runtime_evidence"][key]["runtime_sha256"]
            if not isinstance(code, str) or not re.fullmatch(r"0x(?:[0-9a-fA-F]{2})+", code) or hashlib.sha256(bytes.fromhex(code[2:])).hexdigest() != expected:
                raise CheckError("Learning market runtime changed")

    def state(self):
        funded, resolved = (self.call("pool", sig)[0] for sig in ("f3a504f2", "3f6fa655"))
        if funded not in (0, 1) or resolved not in (0, 1):
            raise CheckError("Malformed pool state")
        outcome = self.call("pool", "1bb51c6a")[0] if resolved else None
        if outcome is not None and outcome >= 256:
            raise CheckError("Invalid resolved outcome")
        cash = self.balance("cash", self.m["pool"])
        required, reserve, actual = (self.call("pool", sig)[0] for sig in ("b53105a3", "a88db792", "0019984b"))
        if required != (actual if resolved else max(actual, reserve)):
            raise CheckError("Inconsistent learning collateral requirement")
        return {"phase": "resolved" if resolved else "closed" if self.timestamp >= self.m["closes_at"] else "open" if funded else "unfunded",
                "funded": bool(funded), "resolved": bool(resolved), "resolved_state": outcome, "covered": cash >= required,
                # Internal claims use the pool's collateral check. No external receipt route is enabled.
                "receipt_backed": True, "receipt_supply_atoms": None, "receipt_escrow_atoms": None,
                "pool_collateral_atoms": str(cash), "required_collateral_atoms": str(required),
                "pricing_reserve_atoms": str(reserve), "actual_liability_atoms": str(actual),
                "coverage_surplus_atoms": str(cash - required), "revision": str(self.call("pool", "7cc96380")[0]),
                "updates": str(self.call("pool", "69b4ecc9")[0])}

    def finish(self, payload):
        payload = super().finish(payload)
        payload.update(market_id="learning", contracts={k: self.m[k] for k in ("pool", "cash", "pricing_engine")})
        return payload

    def snapshot(self, wallet=None, claims=None):
        if wallet is not None:
            wallet = address(wallet)
        claims = [(1 << i, 2) for i in range(8)] if claims is None else claims
        if not isinstance(claims, list) or not 1 <= len(claims) <= 16:
            raise ValueError("Request 1-16 claim balances")
        claims = list(dict.fromkeys(claim(*item) for item in claims))
        self.begin()
        if wallet:
            w = int(wallet, 16)
            self.prefetch([("eth_getBalance", [wallet, self.tag]), self.read_call("cash", "70a08231", w),
                           self.read_call("cash", "dd62ed3e", w, int(self.m["pool"], 16))]
                          + [self.read_call("pool", "90fc2c7b", w, s, p) for s, p in claims])
        state = self.state()
        result = {"cluster": {"events": [{"index": i, "label": f"Synthetic event {chr(65+i)}"} for i in range(8)],
                              "rules": RULES, "closes_at": self.m["closes_at"], "liquidity_atoms": "10000000",
                              "collateral_decimals": 6, "collateral_symbol": "AUSD", "resolver": OPERATOR},
                  "pool": state, "wallet": None, "capabilities": {"receipts": False, "kuru": False},
                  "kuru": {"best_bid_wad": None, "best_ask_wad": None}}
        if wallet:
            positions = []
            for s, p in claims:
                amount = str(self.call("pool", "90fc2c7b", w, s, p)[0])
                winner = wins(s, p, state["resolved_state"]) if state["resolved"] else None
                positions.append({"scope": s, "mask": p, "quantity_atoms": amount,
                                  "settlement": "pending" if winner is None else "winning" if winner else "losing",
                                  "redeemable_atoms": None if winner is None else amount if winner else "0"})
            result["wallet"] = {"address": wallet, "native_balance_wei": str(quantity(self.rpc("eth_getBalance", [wallet, self.tag]))),
                                "ausd_atoms": str(self.balance("cash", wallet)), "pool_allowance_atoms": str(self.call("cash", "dd62ed3e", w, int(self.m["pool"], 16))[0]),
                                "receipt_atoms": None, "margin_available_ausd_atoms": None, "margin_available_receipt_atoms": None,
                                "positions_scope": "requested_claims_only", "positions": positions}
        result = self.finish(result)
        result["trading_available"] = state["phase"] == "open" and state["covered"] and not result["snapshot"]["stale"] and self.clock() < self.m["closes_at"]
        result["redemption_available"] = state["resolved"] and state["covered"] and not result["snapshot"]["stale"]
        result["conversion_available"] = False
        return result
