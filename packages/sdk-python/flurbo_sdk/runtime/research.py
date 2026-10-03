"""Research on the operator's machine (protocol/specs/research.md). Retrieval is explicit and allowlisted;
retrieved text is untrusted data; the model has no tools and never sees keys or wallet details; every
output is validated; every failure is an abstention with a reason."""
import email.utils
import hashlib
import http.client
import json
import re
import socket
import time
import urllib.error
import urllib.request
from urllib.parse import urljoin, urlparse

from ..errors import FlurboError
from ..research import EVIDENCE_SCHEMA, build_research_prompt, evidence_failure, evidence_observed_at, forecast_from_model, valid_evidence, validate_model_output


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None  # redirects are followed by hand, re-checking the allowlist


def extract_text(body: str, content_type: str = "text/html") -> str:
    if "html" not in content_type:
        return re.sub(r"\s+", " ", body).strip()
    text = re.sub(r"<(script|style|noscript|svg)[\s\S]*?</\1>", " ", body, flags=re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    for a, b in (("&nbsp;", " "), ("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", '"'), ("&#39;", "'")):
        text = text.replace(a, b)
    return re.sub(r"\s+", " ", text).strip()


class HttpRetriever:
    """Fetches allowlisted HTTPS pages (by default the source each market publishes for its events).
    allow_local_http permits plain HTTP to this machine only (local test evidence)."""
    name = "http"

    def __init__(self, allow_hosts: list[str], allow_local_http: bool = False, max_bytes: int = 2_000_000, timeout: float = 10.0, max_sources: int = 6, opener=None):
        self.allow = {h.lower() for h in allow_hosts}
        self.allow_local_http, self.max_bytes, self.timeout, self.max_sources = allow_local_http, max_bytes, timeout, max_sources
        self._open = (opener or urllib.request.build_opener(_NoRedirect)).open

    def _allowed(self, url: str) -> bool:
        u = urlparse(url)
        if u.username or u.password:
            return False
        return (u.scheme == "https" and (u.hostname or "").lower() in self.allow) or (self.allow_local_http and u.scheme == "http" and u.hostname in ("127.0.0.1", "localhost"))

    def _get(self, url: str):
        for _ in range(4):
            if not self._allowed(url):
                raise FlurboError("forbidden", "Source host not allowlisted.")
            try:
                return self._open(urllib.request.Request(url, headers={"Accept": "text/html,application/json,text/plain"}), timeout=self.timeout), url
            except urllib.error.HTTPError as e:
                if 300 <= e.code < 400 and e.headers.get("Location"):
                    url = urljoin(url, e.headers["Location"])
                    continue
                raise
        raise FlurboError("invalid_response", "Too many redirects.")

    def retrieve(self, sources: list[dict], now: int) -> list[dict]:
        out = []
        for source in sources[: self.max_sources]:
            try:
                response, final_url = self._get(source["url"])
                with response as r:
                    content_type = r.headers.get("Content-Type", "")
                    if r.status != 200 or r.headers.get("Content-Range") is not None or not re.search(r"text/|application/(json|xhtml)", content_type):
                        continue
                    raw = r.read(self.max_bytes + 1)
                    if not raw or len(raw) > self.max_bytes:
                        continue
                    length = r.headers.get("Content-Length")
                    if length is not None and (not length.isdecimal() or int(length) != len(raw)):
                        continue
                    modified = r.headers.get("Last-Modified")
                text = raw.decode("utf-8", errors="replace")
                title = re.search(r"<title[^>]*>([^<]{1,160})</title>", text, re.I)
                published = None
                if modified:
                    try:
                        published = int(email.utils.parsedate_to_datetime(modified).timestamp())
                    except (TypeError, ValueError):
                        published = None
                excerpt = extract_text(text, content_type)[:4000]
                if not excerpt.strip():
                    continue
                out.append({"schema": EVIDENCE_SCHEMA, "id": f"src-{len(out) + 1}", "url": final_url, "requestedUrl": source["url"], "finalUrl": final_url,
                            "title": title.group(1).strip() if title else final_url, "publisher": urlparse(final_url).netloc,
                            "retrievedAt": now, "publisherReleasedAt": None, "httpLastModified": published, "completeDocument": True,
                            "capturedBytes": len(raw), "eventIds": [source["event"]], "contentSha256": hashlib.sha256(raw).hexdigest(), "excerpt": excerpt})
            except (FlurboError, OSError, ValueError, urllib.error.URLError, http.client.HTTPException):
                continue  # a failed source is skipped; research abstains if nothing usable remains
        return out


class FixtureRetriever:
    """Deterministic evidence for offline tests and examples. Labelled as fixture evidence."""
    name = "fixture"

    def __init__(self, records: list[dict]):
        self.records = records

    def retrieve(self, sources: list[dict], now: int) -> list[dict]:
        return [{**r, "retrievedAt": now} for r in self.records]


class ProviderError(FlurboError):
    def __init__(self, reason: str, message: str):
        super().__init__("rate_limited" if reason == "rate_limited" else "timeout" if reason == "timeout" else "provider_unavailable", message)
        self.reason = reason


def _post(url: str, headers: dict, body: dict, timeout: float, max_retries: int, opener) -> dict:
    """A timeout and bounded retries for transport errors, 429 and 5xx only. Provider error bodies are never
    surfaced (they can echo keys or prompts)."""
    for attempt in range(max_retries + 1):
        request = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"Content-Type": "application/json", **headers}, method="POST")
        try:
            with opener(request, timeout=timeout) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if (e.code == 429 or e.code >= 500) and attempt < max_retries:
                retry = e.headers.get("Retry-After") if e.headers else None
                time.sleep(min(int(retry) if retry and retry.isdigit() else 2**attempt, 10))
                continue
            raise ProviderError("rate_limited" if e.code == 429 else "provider_unavailable", f"The model provider refused the request (HTTP {e.code}).") from None
        except (socket.timeout, TimeoutError):
            if attempt < max_retries:
                continue
            raise ProviderError("timeout", "The model provider did not respond in time.") from None
        except (urllib.error.URLError, OSError, ValueError):
            if attempt < max_retries:
                time.sleep(0.5 * 2**attempt)
                continue
            raise ProviderError("provider_unavailable", "The model provider could not be reached.") from None
    raise ProviderError("provider_unavailable", "The model provider failed.")


class OpenAICompatible:
    """Any service implementing the OpenAI chat completions API (hosted providers, or a local model server)."""
    kind = "model"

    def __init__(self, base_url: str, model: str, api_key: str | None, timeout: float = 60.0, max_retries: int = 2, opener=None, name: str | None = None):
        u = urlparse(base_url)
        local = u.hostname in ("127.0.0.1", "localhost")
        if u.scheme != "https" and not local:
            raise FlurboError("invalid_input", "Use HTTPS for a remote model provider.")
        if not api_key and not local:
            raise ProviderError("provider_not_configured", "No API key configured for the model provider.")
        self.base, self.model, self._key, self.timeout, self.max_retries = base_url.rstrip("/") + "/", model, api_key, timeout, min(max_retries, 3)
        self._open = opener or urllib.request.urlopen
        self.name = name or f"{u.hostname}/{model}"

    def __repr__(self) -> str:
        return f"OpenAICompatible({self.name})"

    def complete(self, prompt: dict) -> str:
        r = _post(urljoin(self.base, "chat/completions"), {"Authorization": f"Bearer {self._key}"} if self._key else {},
                  {"model": self.model, "temperature": 0, "response_format": {"type": "json_object"},
                   "messages": [{"role": "system", "content": prompt["system"]}, {"role": "user", "content": prompt["user"]}]}, self.timeout, self.max_retries, self._open)
        try:
            content = r["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError):
            content = None
        if not isinstance(content, str):
            raise ProviderError("malformed_output", "The model returned no text.")
        return content


class AnthropicMessages:
    kind = "model"

    def __init__(self, model: str, api_key: str | None, base_url: str = "https://api.anthropic.com/", max_tokens: int = 1500, timeout: float = 60.0, max_retries: int = 2, opener=None):
        if not api_key:
            raise ProviderError("provider_not_configured", "No API key configured for the model provider.")
        self.model, self._key, self.base, self.max_tokens, self.timeout, self.max_retries = model, api_key, base_url, max_tokens, timeout, min(max_retries, 3)
        self._open = opener or urllib.request.urlopen
        self.name = f"anthropic/{model}"

    def __repr__(self) -> str:
        return f"AnthropicMessages({self.name})"

    def complete(self, prompt: dict) -> str:
        r = _post(urljoin(self.base, "v1/messages"), {"x-api-key": self._key, "anthropic-version": "2023-06-01"},
                  {"model": self.model, "max_tokens": self.max_tokens, "temperature": 0, "system": prompt["system"], "messages": [{"role": "user", "content": prompt["user"]}]},
                  self.timeout, self.max_retries, self._open)
        text = "".join(c.get("text", "") for c in r.get("content", []) if isinstance(c, dict) and c.get("type") == "text") if isinstance(r, dict) else ""
        if not text:
            raise ProviderError("malformed_output", "The model returned no text.")
        return text


class FixtureForecaster:
    """A fixed reply, for offline tests and examples. Always reported as a fixture, never as a model."""
    kind = "fixture"

    def __init__(self, reply, name: str = "offline-fixture"):
        self._reply, self.name = reply, name

    def complete(self, prompt: dict) -> str:
        return self._reply(prompt) if callable(self._reply) else self._reply


class Researcher:
    """Request budgets: per cycle (reset by the runner) and per rolling hour, counted in this process."""

    def __init__(self, retriever, forecaster, max_evidence_age_seconds: int, per_cycle: int, per_hour: int, now=None):
        self.retriever, self.forecaster = retriever, forecaster
        self.max_age, self.per_cycle, self.per_hour = max_evidence_age_seconds, per_cycle, per_hour
        self.now = now or (lambda: int(time.time()))
        self._cycle, self._hour = 0, []

    def reset_cycle(self) -> None:
        self._cycle = 0

    def research(self, pool: str, title: str, event_count: int, events: list[dict], sources: list[dict], evidence_requirements: list[dict] | None = None) -> dict:
        t = self.now()
        if isinstance(self.forecaster, ProviderError):
            return {"status": "abstain", "reason": self.forecaster.reason, "detail": str(self.forecaster), "evidence": [], "provenance": None}
        provenance = {"kind": self.forecaster.kind, "name": self.forecaster.name}
        self._hour = [x for x in self._hour if x > t - 3600]
        if self._cycle >= self.per_cycle or len(self._hour) >= self.per_hour:
            return {"status": "abstain", "reason": "request_budget_exhausted", "detail": "The research request budget is used up.", "evidence": [], "provenance": provenance}
        evidence = self.retriever.retrieve(sources, t)
        if not evidence:
            return {"status": "abstain", "reason": "no_sources", "detail": "No evidence could be retrieved from the allowed sources.", "evidence": evidence, "provenance": provenance}
        usable = [e for e in evidence if valid_evidence(e, t, event_count)]
        ctx = {"requestedEvents": [e["index"] for e in events], "eventCount": event_count, "evidence": evidence, "now": t, "maxEvidenceAgeSeconds": self.max_age, "evidenceRequirements": evidence_requirements or []}
        failure = evidence_failure(usable, ctx) if usable else "invalid_evidence"
        if failure:
            return {"status": "abstain", "reason": failure, "detail": f"Evidence validation failed: {failure}.", "evidence": evidence, "provenance": provenance}
        self._cycle += 1
        self._hour.append(t)
        try:
            reply = self.forecaster.complete(build_research_prompt(title, events, usable, t, evidence_requirements, event_count))
        except ProviderError as e:
            return {"status": "abstain", "reason": e.reason, "detail": str(e), "evidence": evidence, "provenance": provenance}
        except Exception:
            return {"status": "abstain", "reason": "provider_unavailable", "detail": "The model provider failed.", "evidence": evidence, "provenance": provenance}
        outcome = validate_model_output(reply, ctx)
        if outcome["status"] == "abstain":
            return {"status": "abstain", "reason": outcome["reason"], "detail": f"The forecast was not used: {outcome['reason']}.", "modelReason": outcome.get("modelReason"), "evidence": evidence, "provenance": provenance}
        output = outcome["output"]
        fresh = sum(1 for e in evidence if e["id"] in output["evidenceIds"] and (observed := evidence_observed_at(e, output["events"], evidence_requirements)) is not None and 0 <= t - observed <= self.max_age)
        return {"status": "ok", "output": output, "freshEvidence": fresh, "forecast": forecast_from_model(output, pool, evidence, provenance, t, evidence_requirements), "evidence": evidence, "provenance": provenance}
