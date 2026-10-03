from .capacity import permit, cooldown
"""Headless transport for the Flurbo agent runtime API. The credential is sent only in the Authorization
header, never in a URL, and never included in errors or logs."""
import json
import re
import urllib.error
import urllib.request
from urllib.parse import quote, urljoin, urlparse

from ..errors import FlurboError
from ..protocol import PROTOCOL_HEADER, PROTOCOL_VERSION, RUNTIME_API_BASE, STOP_CODES, parse_deployment

TOKEN = re.compile(r"^fla1_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$")


class RuntimeApiError(FlurboError):
    def __init__(self, api_code: str, message: str, status: int | None, retry_after: int | None = None):
        code = {401: "unauthenticated", 403: "forbidden", 404: "not_found", 409: "conflict", 429: "rate_limited"}.get(status or 0, "unavailable")
        super().__init__(code, message, status)
        self.api_code = api_code
        self.stop = api_code in STOP_CODES
        self.retry_after = retry_after


class RuntimeClient:
    def __init__(self, base_url: str, token: str, timeout: float = 20.0, opener=None):
        parsed = urlparse(base_url)
        if parsed.scheme != "https" and parsed.hostname not in ("127.0.0.1", "localhost"):
            raise FlurboError("invalid_input", "Use HTTPS for the Flurbo API.")
        if not isinstance(token, str) or not TOKEN.match(token):
            raise FlurboError("unauthenticated", "The agent credential is missing or malformed.")
        self._base, self._token, self._timeout = base_url, token, timeout
        self._open = opener or urllib.request.urlopen

    def __repr__(self) -> str:  # never print the credential
        return f"RuntimeClient({self._base})"

    def _call(self, method: str, path: str, body=None):
        headers = {"Authorization": f"Bearer {self._token}", PROTOCOL_HEADER: PROTOCOL_VERSION}
        data = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(body).encode()
        request = urllib.request.Request(urljoin(self._base, RUNTIME_API_BASE + path), data=data, headers=headers, method=method)
        try:
            with permit(request.full_url), self._open(request, timeout=self._timeout) as response:
                return json.loads(response.read() or b"null")
        except urllib.error.HTTPError as e:
            if e.code == 429: cooldown(request.full_url, e.headers.get("Retry-After") if e.headers else None)
            try:
                parsed = json.loads(e.read())
            except Exception:
                parsed = None
            finally:
                e.close()
            code = parsed.get("code") if isinstance(parsed, dict) and isinstance(parsed.get("code"), str) else "UNAVAILABLE"
            message = parsed.get("error") if isinstance(parsed, dict) and isinstance(parsed.get("error"), str) and len(parsed["error"]) < 300 else "The Flurbo API refused the request."
            retry = e.headers.get("Retry-After") if e.headers else None
            raise RuntimeApiError(code, message, e.code, int(retry) if retry and retry.isdigit() else None) from None
        except FlurboError:
            raise
        except Exception:
            raise RuntimeApiError("NETWORK", "The Flurbo API could not be reached.", None) from None

    def session(self):
        return self._call("GET", "/session")

    def deployments(self) -> list[dict]:
        r = self._call("GET", "/deployments")
        if not isinstance(r, dict) or r.get("schema") != "flurbo.agent-deployments.v1" or not isinstance(r.get("deployments"), list):
            raise FlurboError("invalid_response", "Unexpected deployments response.")
        return [parse_deployment(d) for d in r["deployments"]]

    def market(self, namespace: str):
        return self._call("GET", f"/markets/{quote(namespace)}")

    def validate_trade(self, namespace: str, claim: dict, quantity):
        return self._call("POST", f"/markets/{quote(namespace)}/validate-trade", {"scope": claim["scope"], "mask": str(claim["mask"]), "quantityAtoms": str(quantity)})

    def pair_analytics(self, namespace: str, a: int, b: int):
        return self._call("POST", f"/markets/{quote(namespace)}/pair-analytics", {"a": a, "b": b})

    def wallet(self, namespace: str, claims: list[dict]):
        return self._call("POST", f"/markets/{quote(namespace)}/wallet", {"claims": claims})

    def policy(self):
        return self._call("GET", "/policy")

    def heartbeat(self, beat: dict):
        return self._call("POST", "/heartbeat", beat)

    def decision(self, decision: dict):
        return self._call("POST", "/decisions", decision)

    def report_execution(self, report: dict):
        return self._call("POST", "/executions", report)

    def execution(self, tx_hash: str):
        return self._call("GET", f"/executions/{tx_hash}")
