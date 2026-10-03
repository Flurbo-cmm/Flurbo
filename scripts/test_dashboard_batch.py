"""Exercise the real batch transport with shuffled and adversarial RPC replies."""
import copy
import io
import json
import unittest
from unittest.mock import patch

from check_monad_readiness import CheckError
from dashboard_data import Dashboard, DashboardRpc
from test_dashboard_data import setup, NETWORK


class Opener:
    def __init__(self, backend, alter=lambda items: items):
        self.backend, self.alter, self.requests = backend, alter, []

    def open(self, request, timeout):
        payload = json.loads(request.data)
        self.requests.append(copy.deepcopy(payload))
        def reply(item):
            return {"jsonrpc": "2.0", "id": item["id"], "result": self.backend(item["method"], item["params"])}
        result = self.alter([reply(item) for item in reversed(payload)]) if isinstance(payload, list) else reply(payload)
        return io.BytesIO(json.dumps(result).encode())


def batched():
    _, backend, manifest = setup()
    rpc = DashboardRpc("https://example.invalid")
    rpc.opener = Opener(backend)
    model = Dashboard(manifest, NETWORK, rpc, "local_fork", clock=lambda: 1000)
    return model, rpc, backend, manifest


class BatchTests(unittest.TestCase):
    def test_wallet_snapshot_matches_sequential_reads_with_fewer_round_trips(self):
        model, rpc, _, manifest = batched()
        sequential, _, _ = setup()
        self.assertEqual(model.snapshot(manifest["operator"]), sequential.snapshot(manifest["operator"]))
        self.assertEqual(len(rpc.opener.requests), 11)
        batches = [p for p in rpc.opener.requests if isinstance(p, list)]
        self.assertEqual(len(batches), 6)
        self.assertTrue(all(len(batch) <= 10 for batch in batches))
        self.assertTrue(all(item["params"][-1] == "0x64" for batch in batches for item in batch))

    def test_cache_is_not_reused_across_snapshots_and_reorg_check_still_runs(self):
        model, rpc, backend, _ = batched()
        model.snapshot()
        backend.empty_code = True
        with self.assertRaisesRegex(CheckError, "code is unavailable"):
            model.snapshot()
        model, rpc, backend, _ = batched()
        backend.changed_tip = True
        with self.assertRaisesRegex(CheckError, "reorganized"):
            model.snapshot()

    def test_quote_and_receipt_reads_preserve_the_existing_results(self):
        model, _, _, _ = batched()
        sequential, _, _ = setup()
        self.assertEqual(model.quote("buy", 128, 2, 1000000), sequential.quote("buy", 128, 2, 1000000))
        self.assertEqual(model.transaction("0x" + "12" * 32), sequential.transaction("0x" + "12" * 32))

    def test_malformed_batches_fail_atomically_without_caching_partial_results(self):
        changes = [lambda r: r[:-1], lambda r: r + [r[0]], lambda r: [r[0]] * len(r),
                   lambda r: [dict(r[0], id=True), *r[1:]],
                   lambda r: [dict(r[0], id=999999), *r[1:]],
                   lambda r: [dict(r[0], error={"message": "remote secret"}), *r[1:]],
                   lambda r: [{k: v for k, v in r[0].items() if k != "result"}, *r[1:]],
                   lambda r: {"jsonrpc": "2.0", "id": None, "error": "batch unsupported"}]
        for change in changes:
            with self.subTest(change=change):
                _, rpc, _, m = batched()
                rpc.opener.alter = change
                with self.assertRaises(CheckError) as error:
                    rpc.prefetch([("eth_getCode", [m["pool"], "0x64"]), ("eth_getCode", [m["cash"], "0x64"])])
                self.assertNotIn("remote secret", str(error.exception))
                self.assertEqual(rpc.prefetched, {})

    def test_batch_never_accepts_writes_or_unpinned_reads(self):
        _, rpc, _, m = batched()
        for calls in ([], [("eth_sendRawTransaction", ["0x01"])], [("eth_getCode", [m["pool"], "latest"])],
                      [("eth_getBlockByNumber", ["0x64", False])], [("eth_getCode", [m["pool"], "0x64"])] * 33):
            with self.assertRaises(CheckError): rpc.prefetch(calls)
        self.assertEqual(rpc.opener.requests, [])

    def test_public_rate_budget_is_shared_and_private_rpc_is_not_delayed(self):
        first = DashboardRpc("https://testnet-rpc.monad.xyz")
        second = DashboardRpc("https://testnet-rpc.monad.xyz")
        private = DashboardRpc("https://monad-testnet.g.alchemy.com/v2/test")
        clock, sleeps = [0.0], []
        def sleep(seconds):
            sleeps.append(seconds)
            clock[0] += seconds
        first._public_reads.clear()
        try:
            with patch("dashboard_data.time.monotonic", side_effect=lambda: clock[0]), patch("dashboard_data.time.sleep", side_effect=sleep):
                first.pace(10)
                private.pace(10)
                self.assertEqual(sleeps, [])
                second.pace(3)
                self.assertEqual(sleeps, [1.1])
                first.pace(9)
                self.assertEqual(len(first._public_reads), 12)
        finally:
            first._public_reads.clear()

    def test_later_chunk_failure_does_not_cache_earlier_chunks(self):
        _, rpc, _, m = batched()
        chunks = []
        def alter(items):
            chunks.append(items)
            return items if len(chunks) == 1 else []
        rpc.opener.alter = alter
        with self.assertRaises(CheckError):
            rpc.prefetch([("eth_getCode", [m["pool"], hex(i)]) for i in range(11)])
        self.assertEqual(len(chunks), 2)
        self.assertEqual(rpc.prefetched, {})


if __name__ == "__main__":
    unittest.main()
