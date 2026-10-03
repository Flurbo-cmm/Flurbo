from .capacity import permit, cooldown
"""JSON-RPC to the operator's own chain endpoint. Provider error text can contain endpoint details or keys,
so it is never surfaced: callers get a kind and a safe message."""
import itertools
import json
import socket
import urllib.error
import urllib.request
from urllib.parse import urlparse

from ..errors import FlurboError


class RpcError(FlurboError):
    def __init__(self, kind: str, rpc_code: int | None, message: str):
        super().__init__("timeout" if kind == "timeout" else "network", message)
        self.kind = kind
        self.rpc_code = rpc_code


def json_rpc(url: str, timeout: float = 15.0):
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise FlurboError("invalid_input", "The RPC URL must use HTTP or HTTPS.")
    if parsed.scheme == "http" and parsed.hostname not in ("127.0.0.1", "localhost", "::1"):
        raise FlurboError("invalid_input", "Plain HTTP is only allowed for a local chain.")
    ids = itertools.count(1)

    def call(method: str, params: list | None = None):
        call_id = next(ids)
        request = urllib.request.Request(url, data=json.dumps({"jsonrpc": "2.0", "id": call_id, "method": method, "params": params or []}).encode(),
                                         headers={"Content-Type": "application/json"}, method="POST")
        try:
            with permit(url,"rpc"), urllib.request.urlopen(request, timeout=timeout) as response:
                body = json.loads(response.read())
        except (socket.timeout, TimeoutError):
            raise RpcError("timeout", None, f"The chain did not answer {method} in time.") from None
        except urllib.error.HTTPError as e:
            if e.code == 429:
                cooldown(url, e.headers.get("Retry-After") if e.headers else None,"rpc")
                e.close()
                raise FlurboError("rate_limited", "RPC rate limited. Retry after the cooldown.") from None
            try:
                body = json.loads(e.read())
            except Exception:
                raise RpcError("unavailable", None, f"The chain endpoint failed {method}.") from None
        except (urllib.error.URLError, OSError, ValueError):
            raise RpcError("unavailable", None, f"The chain endpoint could not be reached for {method}.") from None
        if isinstance(body, dict) and body.get("error"):
            code = body["error"].get("code") if isinstance(body["error"], dict) else None
            raise RpcError("rejected", code if isinstance(code, int) else None, f"The chain rejected {method}.")
        if not isinstance(body, dict) or body.get("id") != call_id or "result" not in body:
            raise RpcError("unavailable", None, f"The chain endpoint failed {method}.")
        return body["result"]

    return call


def to_hex(n: int) -> str:
    return hex(n)
