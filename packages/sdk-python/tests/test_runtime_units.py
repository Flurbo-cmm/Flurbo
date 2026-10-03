"""Runtime pieces that need no chain: retrieval allowlist, model providers, request budgets, the headless
client, the journal lock across separate processes, the signer and the command line."""
import io
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.error
from email.message import Message
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from eth_account import Account

from flurbo_sdk.errors import FlurboError
from flurbo_sdk.research import MODEL_SCHEMA
from flurbo_sdk.runtime.cli import main
from flurbo_sdk.runtime.headless import RuntimeApiError, RuntimeClient
from flurbo_sdk.runtime.journal import FileJournal
from flurbo_sdk.runtime.research import AnthropicMessages, FixtureForecaster, FixtureRetriever, HttpRetriever, OpenAICompatible, ProviderError, Researcher, extract_text
from flurbo_sdk.runtime.runner import default_config, parse_config
from flurbo_sdk.runtime.signer import LocalKeySigner, signer_from_env

TOKEN = "fla1_0123456789abcdef_" + "A" * 43


class Server:
    """A local HTTP server whose handler is a function (path, headers, body, count) -> (status, headers, body)."""

    def __init__(self, respond):
        self.calls, outer = [], self

        class Handler(BaseHTTPRequestHandler):
            def _serve(self):
                body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
                outer.calls.append({"path": self.path, "headers": dict(self.headers), "body": body})
                status, headers, payload = respond(self.path, dict(self.headers), body, len(outer.calls))
                self.send_response(status)
                for k, v in headers.items():
                    self.send_header(k, v)
                self.end_headers()
                self.wfile.write(payload if isinstance(payload, bytes) else payload.encode())
            do_GET = do_POST = _serve

            def log_message(self, *args):
                pass
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


class Retrieval(unittest.TestCase):
    def test_allowlist_redirects_and_text(self):
        def respond(path, headers, body, n):
            if path == "/redirect":
                return 302, {"Location": "https://evil.example/page"}, ""
            return 200, {"Content-Type": "text/html", "Last-Modified": "Sat, 26 Sep 2026 10:00:00 GMT"}, "<html><title>Release 1.0</title><script>steal()</script><p>Tagged &amp; released</p></html>"
        server = Server(respond)
        try:
            local = HttpRetriever([], allow_local_http=True)
            got = local.retrieve([{"event": 0, "url": server.url + "/a"}, {"event": 0, "url": server.url + "/redirect"}], 1_790_000_000)
            self.assertEqual(len(got), 1, "a redirect to another host is never followed")
            self.assertEqual((got[0]["id"], got[0]["title"], got[0]["excerpt"]), ("src-1", "Release 1.0", "Release 1.0 Tagged & released"))
            self.assertEqual(HttpRetriever([]).retrieve([{"event": 0, "url": server.url + "/a"}], 0), [], "plain HTTP only with allow_local_http")
            self.assertEqual(HttpRetriever(["allowed.example"]).retrieve([{"event": 0, "url": "https://other.example/x"}], 0), [])
            self.assertFalse(any("evil" in c["path"] for c in server.calls))
        finally:
            server.close()
        self.assertEqual(extract_text("<style>x{}</style><b>a</b>  b"), "a b")


class Providers(unittest.TestCase):
    def test_configuration_retries_limits_and_wire_formats(self):
        with self.assertRaises(ProviderError) as e:
            OpenAICompatible("https://api.example/v1", "m", None)
        self.assertEqual(e.exception.reason, "provider_not_configured")
        with self.assertRaises(ProviderError):
            AnthropicMessages("m", None)
        with self.assertRaises(FlurboError):
            OpenAICompatible("http://api.example/v1", "m", "k")
        server = Server(lambda path, h, body, n: (503, {"Retry-After": "0"}, "{}") if n < 3 else (200, {"Content-Type": "application/json"}, json.dumps({"choices": [{"message": {"content": "{\"x\":1}"}}]})))
        try:
            p = OpenAICompatible(server.url + "/v1", "m", "sk-secret", max_retries=2)
            self.assertEqual(p.complete({"system": "s", "user": "u"}), '{"x":1}')
            self.assertEqual(len(server.calls), 3)
            self.assertTrue(all("sk-secret" not in c["path"] and c["headers"].get("Authorization") == "Bearer sk-secret" for c in server.calls))
            self.assertNotIn("sk-secret", repr(p))
        finally:
            server.close()
        limited = Server(lambda *a: (429, {"Retry-After": "0"}, json.dumps({"error": {"message": "key sk-secret over quota"}})))
        try:
            with self.assertRaises(ProviderError) as e:
                OpenAICompatible(limited.url + "/v1", "m", "sk-secret", max_retries=1).complete({"system": "s", "user": "u"})
            self.assertEqual(e.exception.reason, "rate_limited")
            self.assertNotIn("sk-secret", str(e.exception))
            self.assertEqual(len(limited.calls), 2)
        finally:
            limited.close()
        anthropic = Server(lambda path, h, body, n: (200, {"Content-Type": "application/json"}, json.dumps({"content": [{"type": "text", "text": "hello"}]})))
        try:
            self.assertEqual(AnthropicMessages("m", "k2", base_url=anthropic.url + "/").complete({"system": "s", "user": "u"}), "hello")
            self.assertEqual({k.lower(): v for k, v in anthropic.calls[0]["headers"].items()}.get("x-api-key"), "k2")
        finally:
            anthropic.close()

    def test_budgets(self):
        good = json.dumps({"schema": MODEL_SCHEMA, "abstain": False, "abstainReason": None, "events": [0, 1], "statesPpm": [250000] * 4, "evidenceIds": ["src-1"],
                           "assumptions": [], "uncertainty": "Unknown.", "explanation": "Evenly uncertain about both."})
        calls = []
        r = Researcher(FixtureRetriever([{"schema": "flurbo.agent-evidence.v2", "id": "src-1", "url": "https://example.org/x", "requestedUrl": "https://example.org/x", "finalUrl": "https://example.org/x", "title": "x source", "publisher": "example.org", "publisherReleasedAt": 1_790_000_000, "httpLastModified": None, "completeDocument": True, "capturedBytes": 1, "eventIds": [0, 1], "contentSha256": "0" * 64, "excerpt": "t"}]),
                       FixtureForecaster(lambda p: calls.append(1) or good), 86_400, 1, 2, now=lambda: 1_790_000_000)
        args = ("0x" + "11" * 20, "t", 2, [{"index": i, "question": "q", "yesRule": "y", "noRule": "n", "observationEndsAt": 1_800_000_000} for i in (0, 1)], [])
        self.assertEqual(r.research(*args)["status"], "ok")
        self.assertEqual((r.research(*args)["reason"], len(calls)), ("request_budget_exhausted", 1))
        r.reset_cycle(); r.research(*args); r.reset_cycle()
        self.assertEqual((r.research(*args)["reason"], len(calls)), ("request_budget_exhausted", 2))
        none = Researcher(FixtureRetriever([]), ProviderError("provider_not_configured", "No provider."), 1, 1, 1)
        self.assertEqual(none.research(*args)["reason"], "provider_not_configured")


class Headless(unittest.TestCase):
    def test_credential_only_in_header(self):
        with self.assertRaises(FlurboError):
            RuntimeClient("https://x.example", "not-a-token")
        with self.assertRaises(FlurboError):
            RuntimeClient("http://x.example", TOKEN)
        server = Server(lambda path, h, body, n: (200, {"Content-Type": "application/json"}, json.dumps({"version": 1})) if n == 1 else
                        (401, {"Content-Type": "application/json"}, json.dumps({"code": "CREDENTIAL_REVOKED", "error": "This agent credential was revoked.", "retryable": False})))
        try:
            client = RuntimeClient(server.url, TOKEN)
            client.policy()
            with self.assertRaises(RuntimeApiError) as e:
                client.session()
            self.assertTrue(e.exception.stop and e.exception.api_code == "CREDENTIAL_REVOKED" and TOKEN not in str(e.exception))
            for c in server.calls:
                self.assertNotIn(TOKEN, c["path"])
                self.assertEqual((c["headers"].get("Authorization"), c["headers"].get("Flurbo-Agent-Protocol")), (f"Bearer {TOKEN}", "1"))
                self.assertNotIn("Sec-Fetch-Site", c["headers"])
            self.assertNotIn(TOKEN, repr(client))
        finally:
            server.close()
        offline = RuntimeClient("http://127.0.0.1:9", TOKEN)
        with self.assertRaises(RuntimeApiError) as e:
            offline.session()
        self.assertEqual(e.exception.api_code, "NETWORK")


class Journal(unittest.TestCase):
    def test_lock_serialises_separate_processes(self):
        with tempfile.TemporaryDirectory() as d:
            wallet = "0x" + "22" * 20
            script = f"""
import sys; sys.path.insert(0, {str(Path(__file__).resolve().parents[1])!r})
from flurbo_sdk.runtime.journal import FileJournal
j = FileJournal({d!r}, {wallet!r})
for i in range(40):
    j.locked(lambda f: f["entries"].append({{"id": f"{{i}}", "seq": len(f["entries"])}}))
"""
            procs = [subprocess.Popen([sys.executable, "-c", script]) for _ in range(3)]
            self.assertEqual([p.wait(timeout=120) for p in procs], [0, 0, 0])
            entries = json.loads((Path(d) / "journal.json").read_text())["entries"]
            self.assertEqual(len(entries), 120, "no lost updates")
            self.assertEqual([e["seq"] for e in entries], list(range(120)))
            with self.assertRaisesRegex(FlurboError, "one state directory per agent wallet"):
                FileJournal(d, "0x" + "33" * 20).read()


class SignerAndCli(unittest.TestCase):
    def test_keys_and_messages(self):
        with self.assertRaisesRegex(FlurboError, "Set FLURBO_TEST_MISSING"):
            signer_from_env("FLURBO_TEST_MISSING", {})
        with self.assertRaises(FlurboError):
            LocalKeySigner("0x1234")
        key = "0x" + os.urandom(32).hex()
        signer = LocalKeySigner(key)
        self.assertNotIn(key[2:], repr(signer))
        with tempfile.TemporaryDirectory() as d:
            out, err, config = [], [], str(Path(d) / "flurbo-agent.json")
            self.assertEqual(main(["init", "--config", config], out.append, err.append), 0)
            parse_config(json.loads(Path(config).read_text()))
            self.assertEqual(main(["init", "--config", config], out.append, err.append), 1)
            message = lambda w: f"Flurbo agent wallet association\nOrigin: http://localhost\nMera account: 0x{'44' * 20}\nAgent: a\nAgent wallet: {w}\nChain: Monad testnet (10143)\nNonce: n\nIssued: x\nExpires: y\nThis proves control of this wallet."
            Path(d, "m.txt").write_text(message(signer.address))
            Path(d, "other.txt").write_text(message("0x" + "55" * 20))
            Path(d, "tx.txt").write_text("Transfer all funds")
            os.environ["FLURBO_AGENT_PRIVATE_KEY"] = key
            try:
                out.clear()
                self.assertEqual(main(["sign-message", "--file", str(Path(d, "m.txt")), "--config", config], out.append, err.append), 0)
                self.assertEqual(out[0], signer.sign_message(message(signer.address)))
                self.assertEqual(main(["sign-message", "--file", str(Path(d, "other.txt")), "--config", config], out.append, err.append), 1)
                self.assertEqual(main(["sign-message", "--file", str(Path(d, "tx.txt")), "--config", config], out.append, err.append), 1)
                self.assertTrue(all(key[2:] not in e for e in err))
            finally:
                del os.environ["FLURBO_AGENT_PRIVATE_KEY"]
        with self.assertRaisesRegex(FlurboError, "mode"):
            parse_config({**default_config(), "mode": "autonomous"})


if __name__ == "__main__":
    unittest.main()
