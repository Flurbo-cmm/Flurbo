"""Offline tests for read-only scanning, exact calldata and fail-closed policies."""

import copy
import json
from pathlib import Path
import unittest
from unittest.mock import patch

from check_monad_readiness import CheckError, Rpc
from scan_arbitrage import ScanRpc, scan, validate, abi, SELECTORS, EXECUTE, KURU_BUY, KURU_SELL, POOL_BUY, POOL_SELL


def fixture():
    c = json.loads((Path(__file__).resolve().parents[1] / "config/arbitrage-scan.example.json").read_text())
    for i, key in enumerate(("executor", "pool", "market", "receipt", "cash", "operator"), 1):
        c[key] = f"0x{i:040x}"
    c.update(mon_ausd_price_e6=1_000_000, price_observed_at=990, max_fee_per_gas_wei=10**9,
             pool_buy_sizes=[1_000_000], kuru_buy_budgets=[500_000])
    return c


def encoded(*values):
    return abi("", *values)


class FakeRpc:
    def __init__(self, config):
        self.c = config
        self.calls = []
        self.chain = 10143
        self.hash = "0x" + "aa" * 32
        self.reorg = False
        self.advance = 0
        self.empty_code = False
        self.wrong_binding = False
        self.bad_canonical = False
        self.bad_pair = False
        self.bad_result = False
        self.reject_estimate = False
        self.estimate = 800000
        self.final_estimate = 800100
        self.gas_price = 10**9
        self.net_sell = 897300
        self.timestamp = 995
        self.head_reads = 0

    def __call__(self, method, params):
        self.calls.append((method, copy.deepcopy(params)))
        if method == "eth_chainId":
            return hex(self.chain)
        if method == "eth_getBlockByNumber":
            latest = params[0] == "latest"
            self.head_reads += latest
            n = 100 + (self.advance if latest and self.head_reads > 1 else 0)
            return {"number": hex(n), "timestamp": hex(self.timestamp),
                    "hash": "0x" + "bb" * 32 if self.reorg and not latest else self.hash}
        if method == "eth_getCode":
            return "0x" if self.empty_code else "0x6000"
        if method == "eth_gasPrice":
            return hex(self.gas_price)
        if method == "eth_estimateGas":
            if self.reject_estimate:
                raise CheckError("eth_estimateGas: RPC rejected read; remote details withheld")
            return hex(self.final_estimate if "gas" in params[0] else self.estimate)
        if method != "eth_call":
            raise AssertionError("Write or unknown RPC method")
        tx = params[0]
        selector = tx["data"][2:10]
        args = [int(tx["data"][i:i + 64], 16) for i in range(10, len(tx["data"]), 64)]
        for key, sig in SELECTORS.items():
            if selector == sig:
                value = self.c[key] if key in ("scope", "mask") else int(self.c[key], 16)
                return encoded(value + int(self.wrong_binding))
        if selector == "7220c660":
            return encoded(int(self.c["receipt"], 16) + int(self.bad_canonical))
        if selector == "90c9427c":
            return encoded(10**6, 10**6, int(self.c["receipt"], 16), 18 if self.bad_pair else 6,
                           int(self.c["cash"], 16), 6, 100, 10000, 100000000, 30, 10)
        if selector == "39a3a99a":
            return encoded(2000)
        if selector == POOL_BUY:
            self.assert_args(args, [128, 2, 1000000])
            return encoded(740737)
        if selector == POOL_SELL:
            self.assert_args(args, [128, 2, 997000])
            return encoded(718945)
        if selector in (KURU_BUY, KURU_SELL):
            assert tx["from"] == "0x" + "00" * 20
            assert args[1:] == [0, 0, 1]
            return encoded(997000 if selector == KURU_BUY else self.net_sell)
        if selector == EXECUTE:
            direction, units, spend, receive, allowance, profit, deadline = args
            assert tx["from"] == self.c["operator"] and deadline == 1025 and profit == 10000
            assert units == (1000000 if direction else 997000)
            return encoded(spend, receive, receive - spend, receive - spend - allowance + int(self.bad_result))
        raise AssertionError(f"Unexpected selector {selector}")

    @staticmethod
    def assert_args(actual, expected):
        assert actual == expected


class ScannerTests(unittest.TestCase):
    def test_expired_comparison_never_returns_executable_candidates(self):
        c = fixture()
        rpc = FakeRpc(c)
        rpc.advance = 11
        result = scan(c, rpc, now=1000, comparison_only=True)
        self.assertEqual(result["status"], "expired")
        self.assertTrue(all(row["status"] == "expired_candidate" and "unsigned_transaction" not in row for row in result["candidates"]))
        rpc = FakeRpc(c)
        rpc.advance = 11
        with self.assertRaises(CheckError): scan(c, rpc, now=1000)
        rpc = FakeRpc(c)
        rpc.reorg = True
        with self.assertRaises(CheckError): scan(c, rpc, now=1000, comparison_only=True)

    def test_candidates_use_conservative_gas_exact_calldata_and_one_block(self):
        c = fixture()
        rpc = FakeRpc(c)
        report = scan(c, rpc, now=1000)
        self.assertTrue(report["read_only"])
        self.assertEqual([r["direction"] for r in report["candidates"]], ["kuru_to_pool", "pool_to_kuru"])
        for row in report["candidates"]:
            self.assertEqual(row["status"], "simulated_candidate")
            self.assertEqual(row["gas_limit"], 1000000)
            self.assertEqual(row["gas_allowance_atoms"], 1000)
            self.assertEqual(row["net_after_allowance_atoms"], row["received_atoms"] - row["spent_atoms"] - 1000)
            self.assertEqual(len(row["unsigned_transaction"]["data"]), 2 + 8 + 7 * 64)
        for method, params in rpc.calls:
            self.assertIn(method, ScanRpc.allowed_methods)
            if method in ("eth_call", "eth_getCode", "eth_estimateGas"):
                self.assertEqual(params[-1], "0x64")

    def test_wrong_network_stops_before_contract_reads(self):
        c = fixture()
        rpc = FakeRpc(c)
        rpc.chain = 1
        with self.assertRaises(CheckError):
            scan(c, rpc, now=1000)
        self.assertEqual(rpc.calls, [("eth_chainId", [])])

    def test_missing_deployments_and_stale_conversion_stop_before_rpc(self):
        for key, value in (("executor", None), ("price_observed_at", 1), ("price_observed_at", 1001),
                           ("mon_ausd_price_e6", 0), ("max_fee_per_gas_wei", True),
                           ("scope", 3), ("mask", 3), ("pool_buy_sizes", [2**96]),
                           ("gas_headroom_bps", 10000), ("deadline_seconds", 121)):
            c = fixture()
            c[key] = value
            rpc = FakeRpc(c)
            with self.subTest(key=key, value=value), self.assertRaises(CheckError):
                scan(c, rpc, now=1000)
            self.assertEqual(rpc.calls, [])

    def test_contract_and_freshness_failures_discard_entire_scan(self):
        for attr, value in (("empty_code", True), ("wrong_binding", True), ("bad_canonical", True),
                            ("bad_pair", True), ("gas_price", 10**9 + 1), ("timestamp", 1),
                            ("reorg", True), ("advance", 3)):
            c = fixture()
            rpc = FakeRpc(c)
            setattr(rpc, attr, value)
            with self.subTest(attr=attr), self.assertRaises(CheckError):
                scan(c, rpc, now=1000)

    def test_candidate_failures_never_yield_unsigned_transactions(self):
        for attr, value in (("reject_estimate", True), ("estimate", 2_000_000), ("estimate", 0),
                            ("final_estimate", 1_000_001), ("bad_result", True)):
            c = fixture()
            rpc = FakeRpc(c)
            setattr(rpc, attr, value)
            rows = scan(c, rpc, now=1000)["candidates"]
            with self.subTest(attr=attr):
                self.assertTrue(all(r["status"] == "rejected" for r in rows))
                self.assertTrue(all("unsigned_transaction" not in r for r in rows))

    def test_no_spread_is_rejected_before_estimation_but_other_direction_survives(self):
        c = fixture()
        rpc = FakeRpc(c)
        rpc.net_sell = 740737
        rows = scan(c, rpc, now=1000)["candidates"]
        self.assertEqual([r["status"] for r in rows], ["simulated_candidate", "rejected"])
        self.assertEqual(sum(m == "eth_estimateGas" for m, _ in rpc.calls), 2)

    def test_gas_conversion_rounds_up_and_can_remove_profitable_spread(self):
        c = fixture()
        c["mon_ausd_price_e6"] = 1000001
        rows = scan(c, FakeRpc(c), now=1000)["candidates"]
        self.assertTrue(all(r["gas_allowance_atoms"] == 1001 for r in rows))
        c["mon_ausd_price_e6"] = 300000000
        rows = scan(c, FakeRpc(c), now=1000)["candidates"]
        self.assertTrue(all(r["status"] == "rejected" for r in rows))

    def test_unsigned_encoding_widths_and_no_signing_methods(self):
        for cls in (Rpc, ScanRpc):
            rpc = cls("https://example.invalid")
            for method in ("eth_sendTransaction", "eth_sendRawTransaction", "personal_sign", "eth_sign", "anvil_setBalance"):
                with self.subTest(cls=cls, method=method), self.assertRaises(CheckError):
                    rpc(method, [])
            self.assertEqual(rpc.counter, 0)
        self.assertNotIn("eth_estimateGas", Rpc.allowed_methods)
        self.assertIn("eth_estimateGas", ScanRpc.allowed_methods)
        with self.assertRaises(CheckError):
            abi(EXECUTE, -1)

    def test_time_expiring_during_scan_discards_candidates(self):
        c = fixture()
        with patch("scan_arbitrage.time.time", side_effect=[1000, 1000, 1000, 1030]), self.assertRaises(CheckError):
            scan(c, FakeRpc(c))
        c["max_price_age_seconds"] = 10
        with patch("scan_arbitrage.time.time", side_effect=[1000, 1000, 1000, 1001, 1001, 1001]), self.assertRaises(CheckError):
            scan(c, FakeRpc(c))


if __name__ == "__main__":
    unittest.main()
