"""Deterministic execution policy (protocol/specs/transactions.md).

Software checks in a compliant runtime: they bound what this runtime does, not what the wallet key can do.
"""
from .claims import pays_in
from .protocol import SERVICE_MAX_ATOMS, SERVICE_SLIPPAGE_BPS

VIOLATIONS = ("SERVICE_LIMIT", "MARKET_NOT_ALLOWED", "MARKET_CLOSED", "MARKET_NOT_RESOLVED", "TOO_CLOSE_TO_CLOSE", "ACTION_DISABLED",
              "HOLDINGS_INSUFFICIENT", "QUANTITY_LIMIT", "TRADE_COST_LIMIT", "SLIPPAGE_LIMIT", "QUOTE_STALE", "TOTAL_SPEND_LIMIT",
              "WINDOW_SPEND_LIMIT", "POSITION_LIMIT", "WORST_CASE_LOSS_LIMIT", "GAS_FEE_LIMIT", "GAS_RESERVE", "PENDING_LIMIT")
UNFINISHED = ("planned", "signed", "broadcast")


def _same(a: dict | None, b: dict) -> bool:
    return bool(a) and a["scope"] == b["scope"] and a["mask"] == b["mask"]


def spend_of(e: dict) -> int:
    """What a buy counts toward spending: confirmed cost, the limit while unfinished or unknown, else zero."""
    if e["action"] != "buy":
        return 0
    if e["status"] == "confirmed":
        return int(e.get("costAtoms") or "0")
    if e["status"] in UNFINISHED or e["status"] == "mismatch":
        return int(e["limitAtoms"])
    return 0


def worst_case_loss(inp: dict) -> int:
    """Agent cost basis in this pool minus the lowest total payout over every Yes/No outcome."""
    market, candidate = inp["market"], inp["candidate"]
    positions: dict[tuple[int, int], int] = {}
    cost = 0

    def add(claim: dict, q: int):
        key = (claim["scope"], int(claim["mask"]))
        positions[key] = positions.get(key, 0) + q

    for e in inp["journal"]:
        if e["namespace"] != market["namespace"] or not e.get("claim"):
            continue
        if e["action"] == "buy" and e["status"] == "confirmed":
            add(e["claim"], int(e["quantityAtoms"]))
            cost += int(e.get("costAtoms") or "0")
        elif e["action"] == "buy" and e["status"] in UNFINISHED:
            add(e["claim"], int(e["quantityAtoms"]))
            cost += int(e["limitAtoms"])
        elif e["action"] in ("sell", "redeem") and e["status"] == "confirmed":
            add(e["claim"], -int(e["quantityAtoms"]))
    add(candidate["claim"], int(candidate["quantityAtoms"]))
    cost += int(candidate["limitAtoms"])
    floor = None
    for state in range(2 ** market["eventCount"]):
        payout = sum(q for (scope, mask), q in positions.items() if q > 0 and pays_in(scope, mask, state))
        floor = payout if floor is None or payout < floor else floor
    return cost - (floor or 0)


def evaluate_policy(inp: dict) -> dict:
    p, now, market, wallet, journal, c = inp["policy"], inp["now"], inp["market"], inp["wallet"], inp["journal"], inp["candidate"]
    found: set[str] = set()
    action, quantity, limit = c["action"], int(c["quantityAtoms"]), int(c["limitAtoms"])
    buy, trade = action == "buy", action in ("buy", "sell")
    if quantity < 1 or quantity > SERVICE_MAX_ATOMS or limit > SERVICE_MAX_ATOMS or (trade and c["slippageBps"] not in SERVICE_SLIPPAGE_BPS):
        found.add("SERVICE_LIMIT")
    if c["namespace"] not in p["markets"] or c["namespace"] != market["namespace"]:
        found.add("MARKET_NOT_ALLOWED")
    closed = not market["open"] or now >= market["closesAt"]
    if trade and closed:
        found.add("MARKET_CLOSED")
    if action == "redeem" and not market["resolved"]:
        found.add("MARKET_NOT_RESOLVED")
    if trade and not closed and market["closesAt"] - now < p["minSecondsBeforeClose"]:
        found.add("TOO_CLOSE_TO_CLOSE")
    if (action == "sell" and not p["allowSell"]) or (action == "redeem" and not p["allowRedeem"]):
        found.add("ACTION_DISABLED")
    held = sum(int(h["quantityAtoms"]) for h in wallet["holdings"] if _same(h, c["claim"]))
    if not buy and held < quantity:
        found.add("HOLDINGS_INSUFFICIENT")
    if quantity > int(p["maxQuantityAtoms"]):
        found.add("QUANTITY_LIMIT")
    if buy and limit > int(p["maxTradeCostAtoms"]):
        found.add("TRADE_COST_LIMIT")
    if trade and c["slippageBps"] > p["maxSlippageBps"]:
        found.add("SLIPPAGE_LIMIT")
    if trade and now - c["quoteBlockTimestamp"] > p["quoteMaxAgeSeconds"]:
        found.add("QUOTE_STALE")
    if buy:
        if sum(spend_of(e) for e in journal) + limit > int(p["spend"]["totalAtoms"]):
            found.add("TOTAL_SPEND_LIMIT")
        for w in p["spend"]["windows"]:
            if sum(spend_of(e) for e in journal if e["plannedAt"] >= now - w["seconds"]) + limit > int(w["atoms"]):
                found.add("WINDOW_SPEND_LIMIT")
        pending_same = sum(int(e["quantityAtoms"]) for e in journal
                           if e["action"] == "buy" and e["status"] in UNFINISHED and e["namespace"] == c["namespace"] and _same(e.get("claim"), c["claim"]))
        if held + pending_same + quantity > int(p["maxPositionAtoms"]):
            found.add("POSITION_LIMIT")
        if worst_case_loss(inp) > int(p["maxWorstCaseLossAtoms"]):
            found.add("WORST_CASE_LOSS_LIMIT")
    fee = int(c["gasLimit"]) * int(c["maxFeePerGas"])
    if fee > int(p["gas"]["maxFeeWei"]):
        found.add("GAS_FEE_LIMIT")
    if int(wallet["nativeBalanceWei"]) - fee < int(p["gas"]["reserveWei"]):
        found.add("GAS_RESERVE")
    if sum(1 for e in journal if e["status"] in UNFINISHED) >= p["maxPending"]:
        found.add("PENDING_LIMIT")
    violations = [v for v in VIOLATIONS if v in found]
    return {"ok": not violations, "violations": violations}


def effective_policy(local: dict, flurbo: dict | None, read_at: int | None, now: int, policy_max_age_seconds: int) -> dict:
    """Flurbo's published policy tightens the local configuration; it never loosens it."""
    server_max = (flurbo or {}).get("limits", {}).get("maxTradeCostAtoms")
    max_trade = server_max if server_max is not None and int(server_max) < int(local["maxTradeCostAtoms"]) else local["maxTradeCostAtoms"]
    windows = list(local["spend"]["windows"]) + list((flurbo or {}).get("limits", {}).get("windows", []))
    stale = read_at is None or now - read_at > policy_max_age_seconds
    if local["mode"] != "live":
        reason = "local_paper_mode"
    elif flurbo is None:
        reason = "policy_stale"
    elif not flurbo["liveEnabled"]:
        reason = "live_disabled"
    elif flurbo["paused"]:
        reason = "paused"
    elif stale:
        reason = "policy_stale"
    else:
        reason = None
    return {"maxTradeCostAtoms": max_trade, "windows": windows, "liveAllowed": reason is None, "reason": reason}
