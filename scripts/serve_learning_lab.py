"""Serve the local learning dashboard with an owned, separate synthetic Anvil chain."""
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import shutil
import socket
import subprocess
import time
from urllib.parse import parse_qs, urlsplit

from learning_lab import CHAIN, LearningLab, LocalRpc
from rehearse_learning_update import ROOT, run

STATIC = {"/": ("learning.html", "text/html"), "/styles.css": ("styles.css", "text/css"),
          "/metamask.mjs": ("metamask.mjs", "text/javascript"),
          "/learning.css": ("learning.css", "text/css"),
          "/learning-app.mjs": ("learning-app.mjs", "text/javascript"),
          "/learning-wallet.mjs": ("learning-wallet.mjs", "text/javascript")}


def handler(lab):
    class Handler(BaseHTTPRequestHandler):
        def respond(self, status, data, mime="application/json"):
            data = json.dumps(data).encode() if mime == "application/json" else data
            self.send_response(status)
            for key, value in {"Content-Type": mime + "; charset=utf-8", "Content-Length": str(len(data)),
                "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
                "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"}.items():
                self.send_header(key, value)
            self.end_headers()
            try:
                self.wfile.write(data)
            except ConnectionError:
                pass

        def local(self, post=False):
            host = self.headers.get("Host")
            valid = host in {f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}"}
            valid = valid and self.headers.get("Origin") in ((f"http://{host}",) if post else (None, f"http://{host}"))
            if not valid:
                self.respond(403, {"error": "Exact local origin required"})
            return valid

        def do_GET(self):
            if not self.local():
                return
            try:
                if self.path in STATIC:
                    path, mime = STATIC[self.path]
                    return self.respond(200, (ROOT / "apps/dashboard" / path).read_bytes(), mime)
                if len(self.path) > 256:
                    raise ValueError("Request is too long")
                parsed = urlsplit(self.path)
                query = parse_qs(parsed.query, strict_parsing=True)
                with lab.lock:
                    if self.path == "/api/state":
                        result = lab.state()
                    elif parsed.path == "/api/prepare" and set(query) == {"kind"} and len(query["kind"]) == 1:
                        result = lab.prepare(query["kind"][0])
                    else:
                        raise ValueError("Unknown lab route")
                self.respond(200, result)
            except ValueError as error:
                self.respond(400, {"error": str(error)})
            except Exception:
                self.respond(503, {"error": "Simulation or node check failed. Refresh; an update may need its cooldown or epoch budget to reset."})

        def do_POST(self):
            if not self.local(post=True):
                return
            try:
                if self.path != "/api/setup" or self.headers.get("Content-Type") != "application/json" or self.headers.get("Transfer-Encoding"):
                    raise ValueError("Only local setup is supported")
                length = int(self.headers.get("Content-Length", "0"))
                if not 1 <= length <= 256:
                    raise ValueError("Invalid setup request size")
                self.connection.settimeout(5)
                body = json.loads(self.rfile.read(length))
                if not isinstance(body, dict) or set(body) != {"wallet"}:
                    raise ValueError("Provide only a public test account")
                with lab.lock:
                    result = lab.setup(body["wallet"])
                self.respond(200, result)
            except (ValueError, TypeError) as error:
                self.respond(400, {"error": str(error)})
            except Exception:
                self.respond(503, {"error": "Local setup failed; inspect the lab before retrying"})

        def log_message(self, *_):
            pass
    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute-local", action="store_true", required=True)
    for tool in ("anvil", "cast", "forge"):
        parser.add_argument("--" + tool, default=shutil.which(tool) or tool)
    parser.add_argument("--solc", default=str(ROOT / "target/tools/solc-0.8.28.exe"))
    args = parser.parse_args()
    # Never attach to or terminate an existing RPC/server.
    for port in (18548, 18766):
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", port))
    run([args.forge, "test", "--use", args.solc, "--offline", "--match-contract", "FundedFactoredPoolTest",
         "--match-test", "testRuntimeAndConstructorStayWithinDeploymentLimits"])
    model = json.loads(run(["cargo", "run", "--offline", "--quiet", "-p", "flurbo-core", "--example", "parlay_model"]))
    process = subprocess.Popen([args.anvil, "--host", "127.0.0.1", "--port", "18548", "--chain-id", str(CHAIN),
        "--accounts", "3", "--block-time", "2", "--silent"], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
    server = None
    try:
        rpc = LocalRpc()
        for _ in range(100):
            if process.poll() is not None:
                raise RuntimeError("Owned Anvil exited")
            try:
                rpc("web3_clientVersion")
                break
            except OSError:
                time.sleep(0.1)
        else:
            raise RuntimeError("Local node did not start")
        lab = LearningLab(args.cast, model, rpc)
        lab.identity()
        server = ThreadingHTTPServer(("127.0.0.1", 18766), handler(lab))
        print("Learning lab: http://127.0.0.1:18766/ — standalone mock chain; existing demo untouched", flush=True)
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        if server:
            server.server_close()
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


if __name__ == "__main__":
    main()
