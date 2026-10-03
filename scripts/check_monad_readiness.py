"""Read-only Monad/AUSD/Kuru checks. No signing, wallet keys, or transaction RPCs."""

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import sys
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

CONFIG = Path(__file__).resolve().parents[1] / "config" / "monad-readiness.json"
READ_METHODS = {"eth_chainId", "eth_getBlockByNumber", "eth_getCode", "eth_call"}


class CheckError(Exception):
    """Only locally generated, non-secret diagnostic text may enter reports."""


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise CheckError("RPC redirects are not accepted")


def rpc_endpoint(network, provider, environment):
    if provider == "local":
        return "http://127.0.0.1:18545"
    url = network["public_rpc"] if provider == "public" else environment.get(network["alchemy_env"], "")
    if not url:
        raise CheckError(f"Set {network['alchemy_env']} locally; do not paste keys into chat")
    try:
        parsed = urlsplit(url)
        valid = parsed.scheme == "https" and parsed.hostname and not parsed.username and not parsed.password
        valid = valid and not parsed.fragment and parsed.port in (None, 443)
        if provider == "alchemy":
            valid = valid and parsed.hostname == network["alchemy_host"] and parsed.path.startswith("/v2/")
            valid = valid and len(parsed.path.removeprefix("/v2/")) > 0
        elif provider == "quicknode":
            # https://<name>.monad-testnet.quiknode.pro/<token>/ for the network whose Alchemy host names it.
            chain = network["alchemy_host"].split(".", 1)[0]
            valid = valid and re.fullmatch(r"[a-z0-9-]{1,63}\." + re.escape(chain) + r"\.quiknode\.pro", parsed.hostname or "") is not None
            valid = valid and len(parsed.path.strip("/")) > 0
    except ValueError:
        valid = False
    if not valid:
        raise CheckError("Invalid HTTPS RPC configuration for selected provider/network")
    return url


class Rpc:
    allowed_methods = frozenset(READ_METHODS)
    def __init__(self, url):
        self.url = url
        self.counter = 0
        self.opener = build_opener(NoRedirect())

    def __call__(self, method, params):
        if method not in self.allowed_methods:
            raise CheckError("Only readiness read methods are allowed")
        self.counter += 1
        payload = {"jsonrpc": "2.0", "id": self.counter, "method": method, "params": params}
        request = Request(self.url, json.dumps(payload).encode(), {"Content-Type": "application/json"})
        try:
            with self.opener.open(request, timeout=15) as response:
                raw = response.read(2_000_001)
            if len(raw) > 2_000_000:
                raise CheckError("RPC response exceeded size limit")
            result = json.loads(raw)
        except CheckError:
            raise
        except Exception:
            # HTTP bodies, URLs and remote error messages may contain API credentials.
            raise CheckError(f"{method}: transport or JSON failure; remote details withheld") from None
        if not isinstance(result, dict) or result.get("jsonrpc") != "2.0" or result.get("id") != self.counter:
            raise CheckError(f"{method}: invalid JSON-RPC envelope")
        if "error" in result or "result" not in result:
            raise CheckError(f"{method}: RPC rejected read; remote details withheld")
        return result["result"]


def quantity(value):
    if not isinstance(value, str) or not re.fullmatch(r"0x[0-9a-fA-F]{1,64}", value):
        raise CheckError("Malformed RPC hex quantity")
    return int(value, 16)


def inspect(network, rpc):
    chain_id = quantity(rpc("eth_chainId", []))
    if chain_id != network["chain_id"]:
        raise CheckError("RPC chain ID does not match selected network; contract checks stopped")
    block = rpc("eth_getBlockByNumber", ["latest", False])
    if not isinstance(block, dict):
        raise CheckError("Missing block snapshot")
    block_number = quantity(block.get("number"))
    timestamp = quantity(block.get("timestamp"))
    block_hash = block.get("hash")
    if not isinstance(block_hash, str) or not re.fullmatch(r"0x[0-9a-fA-F]{64}", block_hash):
        raise CheckError("Missing block hash")
    tag = hex(block_number)
    checks = []
    for name, address in network["contracts"].items():
        if not re.fullmatch(r"0x[0-9a-fA-F]{40}", address):
            raise CheckError("Malformed configured contract address")
        code = rpc("eth_getCode", [address, tag])
        if not isinstance(code, str) or not re.fullmatch(r"0x(?:[0-9a-fA-F]{2})*", code):
            raise CheckError("Malformed contract bytecode response")
        count = (len(code) - 2) // 2
        checks.append({"contract": name, "address": address, "code_bytes": count,
                       "status": "pass" if count else "fail"})
    ausd_has_code = next(check["code_bytes"] for check in checks if check["contract"] == "ausd")
    decimals = None
    if ausd_has_code:
        word = rpc("eth_call", [{"to": network["contracts"]["ausd"], "data": "0x313ce567"}, tag])
        if not isinstance(word, str) or not re.fullmatch(r"0x[0-9a-fA-F]{64}", word):
            raise CheckError("Malformed AUSD decimals ABI result")
        decimals = int(word, 16)
    # Detect a reorg during the reads; do not claim a consistent observation if the hash changed.
    confirmed = rpc("eth_getBlockByNumber", [tag, False])
    if not isinstance(confirmed, dict) or confirmed.get("hash") != block_hash:
        raise CheckError("Snapshot changed during checks; rerun")
    passed = all(check["status"] == "pass" for check in checks) and decimals == network["ausd_decimals"]
    return {"status": "pass" if passed else "fail", "chain_id": chain_id,
            "block_number": block_number, "block_hash": block_hash, "block_timestamp": timestamp,
            "contracts": checks, "ausd_decimals": decimals,
            "expected_ausd_decimals": network["ausd_decimals"]}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--network", choices=["testnet", "mainnet"], default="testnet")
    parser.add_argument("--provider", choices=["public", "alchemy", "quicknode"], default="public")
    args = parser.parse_args(argv)
    report = {"network": args.network, "provider": args.provider, "read_only": True,
              "observed_at": datetime.now(timezone.utc).isoformat(),
              "scope": "Contract presence and decimals only; not deployment/trading readiness"}
    try:
        network = json.loads(CONFIG.read_text())["networks"][args.network]
        report.update(inspect(network, Rpc(rpc_endpoint(network, args.provider, os.environ))))
    except CheckError as error:
        report.update(status="fail", error=str(error))
    except Exception:
        report.update(status="fail", error="Invalid local configuration or unexpected failure; details withheld")
    print(json.dumps(report, indent=2))
    return 0 if report["status"] == "pass" else 1


if __name__ == "__main__":
    sys.exit(main())
