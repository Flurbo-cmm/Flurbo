"""Dashboard snapshot/quote/receipt validation without network or signing."""

import copy
import unittest

from check_monad_readiness import CheckError
from dashboard_data import Dashboard, DashboardRpc, TRADED, APPROVAL, TRANSFER, REDEEMED, WRAPPED, UNWRAPPED, wins
from scan_arbitrage import abi
from serve_dashboard import route
from test_demo_manifest import FakeRpc as ManifestRpc, fixture, NETWORK
from verify_demo import verify

TX = "0x" + "12" * 32


class FakeRpc(ManifestRpc):
    def __init__(self, m):
        super().__init__(m)
        self.m = m
        self.quote_rejected = False
        self.tx, self.receipt = None, None
        self.changed_tip = False
        self.pool_reads = 0
        self.values[(m["pool"], "1bb51c6a")] = [128]
        self.values[(m["pool"], "a6a83dde")] = [740737]
        self.values[(m["pool"], "f29d0ba9")] = [718945]
        self.values[(m["market"], "b4de8b70")] = [450000000000000000, 500000000000000000]
        self.values[(m["cash"], "dd62ed3e")] = [2**256 - 1]
        self.values[(m["margin"], "d4fac45d")] = [0]

    def __call__(self, method, params):
        if method == "eth_getBalance":
            self.calls.append((method, params))
            return hex(10**22)
        if method == "eth_getTransactionByHash": return self.tx
        if method == "eth_getTransactionReceipt": return self.receipt
        if method == "eth_call":
            sig = params[0]["data"][2:10]
            self.pool_reads += 1
            if sig in ("a6a83dde", "f29d0ba9") and self.quote_rejected:
                raise CheckError("RPC rejected read")
        result = super().__call__(method, params)
        if method == "eth_getBlockByNumber" and params[0] != "latest" and self.changed_tip and self.pool_reads:
            result["hash"] = "0x" + "cc" * 32
        return result


def setup(clock=lambda: 1000):
    m = fixture()
    m = verify(m, NETWORK, ManifestRpc(m))
    m["environment"] = "local_fork"
    rpc = FakeRpc(m)
    return Dashboard(m, NETWORK, rpc, "local_fork", clock), rpc, m


class DashboardTests(unittest.TestCase):
    def test_withdrawal_decodes_only_canonical_ausd_transfer(self):
        model, _, m = setup()
        topic = lambda n: "0x" + f"{n:064x}"
        block_hash = "0x" + "aa" * 32
        log = {"address": m["cash"], "blockHash": block_hash, "transactionHash": TX,
               "removed": False, "topics": [TRANSFER, topic(int(m["operator"], 16)), topic(123)], "data": topic(1500000)}
        receipt = {"blockHash": block_hash, "logs": [log, dict(log, address=m["receipt"])]}
        self.assertEqual(model.receipt_events(receipt, TX), [{"kind": "transfer", "owner": m["operator"],
                          "recipient": "0x" + f"{123:040x}", "amount_atoms": "1500000"}])
        log["removed"] = True
        with self.assertRaises(CheckError): model.receipt_events(receipt, TX)

    def test_public_snapshot_accepts_advancing_head_but_preserves_age_and_canonical_checks(self):
        model, rpc, _ = setup()
        model.m["environment"] = "public_testnet"
        model.begin()
        original = model.rpc
        def advanced(method, params):
            result = original(method, params)
            if method == "eth_getBlockByNumber" and params[0] == "latest":
                result = dict(result, number=hex(model.number + 10))
            return result
        model.rpc = advanced
        self.assertFalse(model.finish({})["snapshot"]["stale"])
        model.clock = lambda: model.timestamp + 31
        self.assertTrue(model.finish({})["snapshot"]["stale"])

    def test_conversion_remains_available_after_resolution_and_shortfall_but_not_stale_or_unbacked(self):
        model, rpc, m = setup()
        self.assertTrue(model.snapshot()['conversion_available'])
        rpc.values[(m['pool'], '3f6fa655')] = [1]
        rpc.values[(m['pool'], 'b53105a3')] = [999999999]
        result = model.snapshot()
        self.assertTrue(result['conversion_available'])
        self.assertFalse(result['redemption_available'])
        model.clock = lambda: 1031
        self.assertFalse(model.snapshot()['conversion_available'])
        model.clock = lambda: 1000
        rpc.values[(m['pool'], '90fc2c7b')] = [1]
        self.assertFalse(model.snapshot()['conversion_available'])

    def test_conversion_events_require_canonical_pool_singleton_and_positive_quantity(self):
        model, _, m = setup()
        topic = lambda n: '0x' + f'{n:064x}'
        receipt = {'blockHash': '0x' + 'aa' * 32}
        log = {'address': m['pool'], 'blockHash': receipt['blockHash'], 'transactionHash': TX,
               'topics': [WRAPPED, topic(int(m['operator'], 16)), topic(128), topic(2)], 'data': abi('', 500000)}
        receipt['logs'] = [log]
        self.assertEqual(model.receipt_events(receipt, TX)[0]['kind'], 'wrap')
        log['topics'][0] = UNWRAPPED
        self.assertEqual(model.receipt_events(receipt, TX)[0]['kind'], 'unwrap')
        log['address'] = m['executor']
        self.assertEqual(model.receipt_events(receipt, TX), [])
        log['address'] = m['pool']; log['topics'][2] = topic(3)
        with self.assertRaises(CheckError): model.receipt_events(receipt, TX)
        log['topics'][2] = topic(128); log['data'] = abi('', 0)
        with self.assertRaises(CheckError): model.receipt_events(receipt, TX)
        log['data'] = abi('', 500000); log['removed'] = True
        with self.assertRaises(CheckError): model.receipt_events(receipt, TX)

    def test_settlement_payouts_project_nonadjacent_events_and_preserve_pending(self):
        model, rpc, m = setup()
        pending = model.snapshot(m['operator'], [(129, 8), (129, 1)])
        self.assertFalse(pending['redemption_available'])
        self.assertIsNone(pending['wallet']['positions'][0]['redeemable_atoms'])
        rpc.values[(m['pool'], '3f6fa655')] = [1]
        rpc.values[(m['pool'], '1bb51c6a')] = [129]
        settled = model.snapshot(m['operator'], [(129, 8), (129, 1)])
        self.assertTrue(settled['redemption_available'])
        self.assertFalse(settled['trading_available'])
        winner, loser = settled['wallet']['positions']
        self.assertEqual((winner['settlement'], winner['redeemable_atoms']), ('winning', '10000000'))
        self.assertEqual((loser['settlement'], loser['redeemable_atoms']), ('losing', '0'))
        for outcome in range(256):
            self.assertEqual(wins(129, 8, outcome), bool(outcome & 1 and outcome & 128))
        model.clock = lambda: 1031
        self.assertFalse(model.snapshot()['redemption_available'])
        model.clock = lambda: 1000
        rpc.values[(m['pool'], 'b53105a3')] = [999999999]
        self.assertFalse(model.snapshot()['redemption_available'])

    def test_redemption_events_require_exact_canonical_payout_encoding(self):
        model, _, m = setup()
        topic = lambda value: '0x' + f'{value:064x}'
        receipt = {'blockHash': '0x' + 'aa' * 32}
        log = {'address': m['pool'], 'blockHash': receipt['blockHash'], 'transactionHash': TX,
               'topics': [REDEEMED, topic(int(m['operator'], 16)), topic(129), topic(8)], 'data': abi('', 500000, 500000)}
        receipt['logs'] = [log]
        self.assertEqual(model.receipt_events(receipt, TX)[0]['collateral_atoms'], '500000')
        log['data'] = abi('', 500000, 0)
        self.assertEqual(model.receipt_events(receipt, TX)[0]['collateral_atoms'], '0')
        log['data'] = abi('', 500000, 1)
        with self.assertRaises(CheckError): model.receipt_events(receipt, TX)
        log['data'] = abi('', 500000, 0); log['removed'] = True
        with self.assertRaises(CheckError): model.receipt_events(receipt, TX)

    def test_no_wallet_is_not_a_fabricated_account(self):
        model, rpc, _ = setup()
        result = model.snapshot()
        self.assertIsNone(result["wallet"])
        self.assertTrue(result["trading_available"])
        self.assertEqual(result["cluster"]["events"][7]["label"], "Synthetic event H")
        self.assertEqual(result["pool"]["required_collateral_atoms"], "10000000")
        self.assertEqual(result["kuru"]["best_bid_wad"], "450000000000000000")
        for method, params in rpc.calls:
            if method in ("eth_call", "eth_getCode"): self.assertEqual(params[-1], "0x64")

    def test_wallet_amounts_are_exact_strings_and_positions_are_scoped(self):
        model, _, m = setup()
        result = model.snapshot(m["operator"], [(128, 2), (3, 8)])
        w = result["wallet"]
        self.assertEqual(w["native_balance_wei"], str(10**22))
        self.assertEqual(w["pool_allowance_atoms"], str(2**256 - 1))
        self.assertEqual(w["positions_scope"], "requested_claims_only")
        self.assertEqual(len(w["positions"]), 2)
        self.assertEqual(w["margin_available_receipt_atoms"], "0")

    def test_quotes_are_pool_amounts_not_midpoints_or_ownership_approvals(self):
        model, _, _ = setup()
        for side, expected in (("buy", "740737"), ("sell", "718945")):
            result = model.quote(side, 128, 2, 1000000)
            self.assertEqual(result["quote"]["collateral_atoms"], expected)
            self.assertFalse(result["quote"]["ownership_checked"])
            self.assertTrue(result["quote"]["requires_execution_recheck"])
            self.assertEqual(result["quote"]["valid_until"], 1300)

    def test_review_window_is_capped_at_market_close(self):
        model, rpc, m = setup()
        model.m["closes_at"] = 1050
        rpc.values[(m["pool"], "39a3a99a")] = [1050]
        self.assertEqual(model.quote("buy", 128, 2, 1000000)["quote"]["valid_until"], 1049)

    def test_stale_data_is_flagged_and_quote_removed(self):
        model, rpc, _ = setup(clock=lambda: 1031)
        self.assertFalse(model.snapshot()["trading_available"])
        self.assertIsNone(model.quote("buy", 128, 2, 1000000)["quote"])
        self.assertFalse(any(p[0].get("data", "")[2:10] == "a6a83dde" for method, p in rpc.calls if method == "eth_call"))

    def test_closed_and_resolved_pools_remain_readable(self):
        model, rpc, m = setup()
        model.m["closes_at"] = 999
        rpc.values[(m["pool"], "39a3a99a")] = [999]
        self.assertEqual(model.snapshot()["pool"]["phase"], "closed")
        self.assertIsNone(model.quote("buy", 128, 2, 1000)["quote"])
        rpc.values[(m["pool"], "3f6fa655")] = [1]
        result = model.snapshot()
        self.assertEqual(result["pool"]["phase"], "resolved")
        self.assertEqual(result["pool"]["resolved_state"], 128)

    def test_shortfall_and_escrow_mismatch_disable_trading(self):
        for selector, value in (("b53105a3", 999999999), ("90fc2c7b", 1)):
            model, rpc, m = setup()
            rpc.values[(m["pool"], selector)] = [value]
            self.assertFalse(model.snapshot()["trading_available"])
            self.assertIsNone(model.quote("buy", 128, 2, 1000)["quote"])

    def test_manifest_environment_code_and_reorg_fail_closed(self):
        model, rpc, m = setup()
        for field, value in (("status", "unverified"), ("environment", "public_testnet"), ("rules", "real event")):
            bad = copy.deepcopy(m); bad[field] = value
            with self.assertRaises(CheckError): Dashboard(bad, NETWORK, rpc, "local_fork")
        rpc.empty_code = True
        with self.assertRaises(CheckError): model.snapshot()
        model, rpc, m = setup(); rpc.changed_tip = True
        with self.assertRaises(CheckError): model.snapshot()

    def test_quote_rejection_does_not_fall_back_to_cached_price(self):
        model, rpc, _ = setup(); rpc.quote_rejected = True
        result = model.quote("buy", 3, 8, 1000000)
        self.assertEqual(result["quote_status"], "unavailable")
        self.assertIsNone(result["quote"])

    def test_transaction_unknown_pending_success_revert_and_reorg(self):
        model, rpc, m = setup()
        self.assertEqual(model.transaction(TX)["transaction"]["status"], "unknown")
        rpc.tx = {"hash": TX, "from": m["operator"], "to": m["pool"], "blockNumber": None}
        self.assertEqual(model.transaction(TX)["transaction"]["status"], "pending")
        rpc.receipt = {"transactionHash": TX, "blockNumber": "0x64", "blockHash": "0x" + "aa" * 32,
                       "status": "0x1", "gasUsed": "0x5208"}
        item = model.transaction(TX)["transaction"]
        self.assertEqual((item["status"], item["confirmations"], item["gas_used"]), ("succeeded", 1, "21000"))
        rpc.receipt["status"] = "0x0"
        self.assertEqual(model.transaction(TX)["transaction"]["status"], "reverted")
        rpc.receipt["blockHash"] = "0x" + "bb" * 32
        with self.assertRaises(CheckError): model.transaction(TX)

    def test_requests_cannot_add_arbitrary_rpcs_or_invalid_claims(self):
        model, _, _ = setup()
        for path in ("/api/send", "/api/state?wallet=x&wallet=y", "/api/state?rpc=https://example.org",
                     "/api/quote?side=buy&scope=15&mask=2&quantity=1", "/api/state?claims=1:3",
                     "/api/quote?side=buy&scope=1&mask=2&quantity=0"):
            with self.subTest(path=path), self.assertRaises(ValueError): route(model, path)
        rpc = DashboardRpc("https://example.invalid")
        for method in ("eth_sendTransaction", "eth_sendRawTransaction", "eth_sign", "eth_estimateGas", "anvil_setBalance"):
            with self.assertRaises(CheckError): rpc(method, [])
        self.assertEqual(rpc.counter, 0)

    def test_receipt_decodes_only_canonical_pool_trade_and_cash_approval(self):
        model, rpc, m = setup()
        topic = lambda value: "0x" + f"{value:064x}"
        common = {"blockHash": "0x" + "aa" * 32, "transactionHash": TX, "removed": False}
        approval = {**common, "address": m["cash"], "topics": [APPROVAL, topic(int(m["operator"], 16)), topic(int(m["pool"], 16))], "data": topic(251252)}
        trade = {**common, "address": m["pool"], "topics": [TRADED, topic(int(m["operator"], 16)), topic(3), topic(8)], "data": "0x" + "".join(f"{n:064x}" for n in (1, 1000000, 250001))}
        rpc.tx = {"hash": TX, "from": m["operator"], "to": m["pool"], "blockNumber": "0x64", "input": "0x12345678", "value": "0x0"}
        rpc.receipt = {"transactionHash": TX, "blockNumber": "0x64", "blockHash": common["blockHash"], "status": "0x1", "gasUsed": "0x5208", "logs": [approval, trade, {**trade, "address": m["executor"]}]}
        tx = model.transaction(TX)["transaction"]
        self.assertEqual(tx["input"], "0x12345678")
        self.assertEqual(tx["value_wei"], "0")
        self.assertEqual(len(tx["events"]), 2)
        self.assertEqual(tx["events"][0]["amount_atoms"], "251252")
        self.assertEqual(tx["events"][1]["mask"], "8")
        trade["removed"] = True
        with self.assertRaises(CheckError): model.transaction(TX)


if __name__ == "__main__": unittest.main()
