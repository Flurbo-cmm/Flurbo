"""Canonical claims, flurbo.claim.v1 (protocol/specs/claims.md).

A claim is (chain, pool, scope, mask). Scope bit i: event i is part of the claim. Local bit j of a state
is the answer of the j-th selected event in ascending order; mask bit s: the claim pays in local state s.
"""
import re

from .errors import FlurboError

CLAIM_SCHEMA = "flurbo.claim.v1"
CLAIM_RULES = ("AND", "OR", "EXACTLY_ONE", "AT_LEAST_TWO")
_MASK = re.compile(r"^[1-9][0-9]{0,2}$")


def rule_matches(rule: str, matches: list[bool]) -> bool:
    if rule not in CLAIM_RULES or not matches:
        raise FlurboError("unsupported_claim", "Unsupported payout rule.")
    count = sum(1 for m in matches if m)
    if rule == "AND":
        return count == len(matches)
    if rule == "OR":
        return count > 0
    if rule == "EXACTLY_ONE":
        return count == 1
    return count >= 2


def claim_events(scope: int) -> list[int]:
    if not isinstance(scope, int) or isinstance(scope, bool) or scope <= 0 or scope >= 16:
        raise FlurboError("unsupported_claim", "Invalid claim scope.")
    return [i for i in range(4) if scope & (1 << i)]


def validate_claim(scope: int, mask: str, events: int) -> list[int]:
    if events not in (2, 3, 4) or not isinstance(mask, str) or not _MASK.match(mask):
        raise FlurboError("unsupported_claim", "Invalid claim.")
    legs = claim_events(scope)
    if scope >= 2**events or len(legs) > 3 or int(mask) >= (1 << (2 ** len(legs))) - 1:
        raise FlurboError("unsupported_claim", "Unsupported claim.")
    return legs


def claim_valid(scope: int, mask: str, events: int) -> bool:
    try:
        validate_claim(scope, mask, events)
        return True
    except FlurboError:
        return False


def encode_claim(events: int, legs: list[dict], rule: str) -> tuple[int, str]:
    """legs: [{'event': int, 'yes': bool}], sorted internally by event."""
    if not isinstance(legs, list) or not 1 <= len(legs) <= 3 or rule not in CLAIM_RULES:
        raise FlurboError("unsupported_claim", "Choose one to three answers.")
    ordered = sorted(legs, key=lambda leg: leg["event"])
    if len({leg["event"] for leg in ordered}) != len(ordered) or any(
        not isinstance(leg["event"], int) or leg["event"] < 0 or leg["event"] >= events or not isinstance(leg["yes"], bool) for leg in ordered
    ):
        raise FlurboError("unsupported_claim", "Invalid claim answers.")
    if rule == "AT_LEAST_TWO" and len(legs) < 2:
        raise FlurboError("unsupported_claim", "Choose at least two answers.")
    scope = 0
    for leg in ordered:
        scope |= 1 << leg["event"]
    mask = 0
    for state in range(2 ** len(ordered)):
        if rule_matches(rule, [bool(state & (1 << i)) == leg["yes"] for i, leg in enumerate(ordered)]):
            mask |= 1 << state
    validate_claim(scope, str(mask), events)
    return scope, str(mask)


def decode_claim(scope: int, mask: str, events: int = 4) -> dict | None:
    """The named rule that encodes to exactly this mask, or None. Masks are never rewritten."""
    selected = validate_claim(scope, str(mask), events)
    for rule in CLAIM_RULES:
        for state in range(2 ** len(selected) - 1, -1, -1):
            if rule == "AT_LEAST_TWO" and len(selected) < 2:
                continue
            legs = [{"event": e, "yes": bool(state & (1 << i))} for i, e in enumerate(selected)]
            if encode_claim(events, legs, rule)[1] == str(mask):
                return {"rule": rule, "legs": legs}
    return None


def claim_key(chain_id: int, pool: str, scope: int, mask: int | str) -> str:
    return f"{chain_id}:{pool.lower()}:{scope}:{int(mask)}"


def scope_events(scope: int) -> list[int]:
    return [i for i in range(31) if scope & (1 << i)]


def pays_in(scope: int, mask: int, state: int) -> bool:
    """Does the claim pay in a full-pool assignment (bit i = event i is Yes)?"""
    local = 0
    for index, event in enumerate(scope_events(scope)):
        if state & (1 << event):
            local |= 1 << index
    return bool(mask & (1 << local))


def payout_fraction(scope: int, mask: int, event_count: int, yes_mask: int, void_mask: int) -> tuple[int, int]:
    """As PilotPool.payoutFraction: VOID events are averaged over both answers. VOID is not No."""
    full = 2**event_count - 1
    if yes_mask & void_mask or yes_mask > full or void_mask > full:
        raise FlurboError("invalid_input", "Invalid resolution.")
    known = full ^ void_mask
    numerator = denominator = 0
    for state in range(full + 1):
        if (state & known) != yes_mask:
            continue
        denominator += 1
        if pays_in(scope, mask, state):
            numerator += 1
    return numerator, denominator


def claim_probability(joint_events: list[int], states: list[int], scope: int, mask: int) -> int:
    """Probability (ppm) that a claim pays under a joint forecast covering its events."""
    positions = [joint_events.index(e) for e in scope_events(scope)]
    total = 0
    for s, p in enumerate(states):
        local = 0
        for j, pos in enumerate(positions):
            if s & (1 << pos):
                local |= 1 << j
        if mask & (1 << local):
            total += p
    return total


def covers(joint_events: list[int], scope: int) -> bool:
    return all(e in joint_events for e in scope_events(scope))


def marginal(joint_events: list[int], states: list[int], event: int) -> int:
    bit = 1 << joint_events.index(event)
    return sum(p for s, p in enumerate(states) if s & bit)
