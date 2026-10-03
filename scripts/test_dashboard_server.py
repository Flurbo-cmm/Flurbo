"""Check static-route boundaries and local clock safety without sockets or live writes."""

import io
from types import SimpleNamespace
import unittest

from check_monad_readiness import CheckError
from refresh_local_demo import LocalClockRpc, refresh_block
from serve_dashboard import handler


class RequestTests(unittest.TestCase):
    def get(self, path, host="localhost:18765", origin=None):
        def factory():
            raise AssertionError("Static paths must never instantiate the RPC model")
        h = handler(factory).__new__(handler(factory))
        h.path = path
        h.server = SimpleNamespace(server_port=18765)
        h.headers = {"Host": host}
        if origin: h.headers["Origin"] = origin
        h.wfile = io.BytesIO()
        headers = {}
        h.send_response = lambda status: headers.update(status=status)
        h.send_header = lambda key, value: headers.update({key: value})
        h.end_headers = lambda: None
        h.do_GET()
        return headers, h.wfile.getvalue()

    def test_static_assets_and_no_rpc_or_arbitrary_files(self):
        for path, mime in (("/", "text/html"), ("/app.mjs", "text/javascript"), ("/claims.mjs", "text/javascript"), ("/styles.css", "text/css")):
            headers, body = self.get(path)
            self.assertEqual(headers["status"], 200)
            self.assertTrue(headers["Content-Type"].startswith(mime))
            self.assertEqual(headers["Cache-Control"], "no-store")
            self.assertIn("script-src 'self'", headers["Content-Security-Policy"])
            self.assertTrue(body)
        for path in ("/../config/monad-readiness.json", "/%2e%2e/.git/config", "/app.mjs?file=secret", "/claims.test.mjs"):
            self.assertEqual(self.get(path)[0]["status"], 404)

    def test_static_pages_keep_host_and_origin_boundary(self):
        self.assertEqual(self.get("/", host="evil.example:18765")[0]["status"], 403)
        self.assertEqual(self.get("/", origin="https://evil.example")[0]["status"], 403)
        self.assertEqual(self.get("/", origin="http://localhost:18765")[0]["status"], 200)

    def test_cancelled_browser_request_is_not_retried_as_an_error_response(self):
        cls = handler(lambda: None)
        h = cls.__new__(cls)
        calls = []
        def disconnected(*args):
            calls.append(args)
            raise ConnectionAbortedError()
        h.write_data = disconnected
        h.reply(200, {"test": True})
        self.assertEqual(len(calls), 1)


class ClockTests(unittest.TestCase):
    def test_clock_requires_local_manifest_anvil_chain_checkpoint_and_wall_time(self):
        manifest = {"environment": "local_fork", "status": "verified_snapshot", "verified_block": 1, "verified_block_hash": "0x" + "aa" * 32}
        writes = []
        responses = {"web3_clientVersion": "anvil/v1", "eth_chainId": "0x279f",
                     "eth_getBlockByNumber": {"number": "0x1", "timestamp": "0x3e8", "hash": manifest["verified_block_hash"]}}
        def rpc(method, params):
            if method.startswith("evm_"): writes.append((method, params)); return None
            return responses[method]
        self.assertTrue(refresh_block(rpc, manifest, 1001))
        self.assertEqual(writes, [("evm_setNextBlockTimestamp", [1001]), ("evm_mine", [])])
        writes.clear()
        self.assertFalse(refresh_block(rpc, manifest, 1000))
        with self.assertRaises(CheckError): refresh_block(rpc, manifest, 999)
        for key, value in (("environment", "public_testnet"), ("status", "unverified"), ("verified_block_hash", "0x" + "bb" * 32)):
            with self.assertRaises(CheckError): refresh_block(rpc, {**manifest, key: value}, 1001)
        for key, value in (("web3_clientVersion", "geth/v1"), ("eth_chainId", "0x1")):
            old = responses[key]; responses[key] = value
            with self.assertRaises(CheckError): refresh_block(rpc, manifest, 1001)
            responses[key] = old
        self.assertEqual(writes, [])
        self.assertEqual(LocalClockRpc().url, "http://127.0.0.1:18545")


if __name__ == "__main__": unittest.main()
