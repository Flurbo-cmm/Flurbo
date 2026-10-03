"""Process-wide per-origin transport budgets. Fail locally, never retry a send."""
import threading
import time
from collections import deque
from contextlib import contextmanager
from email.utils import parsedate_to_datetime
from urllib.parse import urlsplit
from ..errors import FlurboError

_lock = threading.Lock()
_buckets = {}

def _bucket(url, lane="api"):
    p = urlsplit(url)
    key = (lane, p.scheme.lower(), p.hostname, p.port)
    if key not in _buckets:
        if len(_buckets) >= 64:
            raise FlurboError("rate_limited", "Too many request origins.")
        _buckets[key] = {"starts": deque(), "active": 0, "until": 0}
    return _buckets[key]

@contextmanager
def permit(url, lane="api"):
    with _lock:
        b, now = _bucket(url,lane), time.time()
        while b["starts"] and b["starts"][0] <= now - 60:
            b["starts"].popleft()
        if b["active"] >= 4 or len(b["starts"]) >= (600 if lane == "rpc" else 100) or now < b["until"]:
            raise FlurboError("rate_limited", "Request capacity reached. Retry after the cooldown.")
        b["active"] += 1
        b["starts"].append(now)
    try:
        yield
    finally:
        with _lock:
            b["active"] -= 1

def cooldown(url, value, lane="api"):
    now = time.time()
    try:
        until = now + max(1, int(value)) if value and value.isdigit() else parsedate_to_datetime(value).timestamp()
    except (TypeError, ValueError, OverflowError, AttributeError):
        until = now + 60
    with _lock:
        b = _bucket(url,lane)
        b["until"] = max(b["until"], now + 1, until)
