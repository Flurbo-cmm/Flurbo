"""The reference strategy joint-edge v1, a port of packages/sdk/src/strategy.ts checked against
protocol/fixtures/strategy.json. Expected value assumes no VOID outcome and excludes gas; edge is a model
estimate, not a promised profit."""
from .amounts import PPM, ceil_div, trunc_div
from .claims import claim_key, claim_probability, covers, encode_claim

STRATEGY = {"id": "joint-edge", "version": "1.0.0"}


def candidate_claims(pool: str, event_count: int, joint_events: list[int], include_singles: bool) -> list[tuple[int, int]]:
    """Single answers (optional), every "all of these" pair combination, "at least one" and "exactly one"
    of each pair's Yes answers. Insertion order, duplicates dropped, at most 24."""
    out: dict[str, tuple[int, int]] = {}

    def add(legs: list[dict], rule: str):
        scope, mask = encode_claim(event_count, legs, rule)
        out.setdefault(claim_key(10143, pool, scope, mask), (scope, int(mask)))

    if include_singles:
        for e in joint_events:
            for yes in (True, False):
                add([{"event": e, "yes": yes}], "AND")
    for i in range(len(joint_events)):
        for j in range(i + 1, len(joint_events)):
            a, b = joint_events[i], joint_events[j]
            for ya in (True, False):
                for yb in (True, False):
                    add([{"event": a, "yes": ya}, {"event": b, "yes": yb}], "AND")
            add([{"event": a, "yes": True}, {"event": b, "yes": True}], "OR")
            add([{"event": a, "yes": True}, {"event": b, "yes": True}], "EXACTLY_ONE")
    return list(out.values())[:24]


def decide(market: dict, forecast: dict, config: dict, now: int, quotes: dict) -> dict:
    """market: {pool, eventCount, open, resolved, closesAt, snapshotBlockHash}; forecast: {events, statesPpm, freshEvidence};
    config: quantityAtoms, slippageBps, minEdgeBps, minEdgeAtoms, maxCostAtoms, minEvidence, includeSingles (ints);
    quotes: claim_key -> {amountAtoms, expiresAt, blockHash} or None."""
    pool, events, states = market["pool"], forecast["events"], forecast["statesPpm"]

    def abstain(reasons: list[str], evaluations: list[dict]) -> dict:
        return {"outcome": "abstain", "reasons": reasons, "proposal": None, "evaluations": evaluations}

    if not market["open"] or market["resolved"] or now >= market["closesAt"]:
        return abstain(["market_closed"], [])
    if forecast["freshEvidence"] < config["minEvidence"]:
        return abstain(["insufficient_evidence"], [])
    claims = [c for c in candidate_claims(pool, market["eventCount"], events, config["includeSingles"]) if covers(events, c[0])]
    if not claims:
        return abstain(["no_supported_claim"], [])
    quantity = config["quantityAtoms"]
    evaluations = []
    for scope, mask in claims:
        p = claim_probability(events, states, scope, mask)
        base = {"scope": scope, "mask": mask, "forecastPpm": p, "quoteAtoms": None, "worstCostAtoms": None, "expectedPayoutAtoms": None, "edgeAtoms": None, "edgeBps": None}
        q = quotes.get(claim_key(10143, pool, scope, mask))
        if q is None or q.get("blockHash") != market["snapshotBlockHash"]:
            evaluations.append({**base, "status": "quote_unavailable"})
            continue
        if now >= q["expiresAt"]:
            evaluations.append({**base, "status": "quote_expired"})
            continue
        worst = ceil_div(q["amountAtoms"] * (10_000 + config["slippageBps"]), 10_000)
        expected = quantity * p // PPM
        edge = expected - worst
        edge_bps = trunc_div(edge * 10_000, worst)
        evaluated = {**base, "quoteAtoms": q["amountAtoms"], "worstCostAtoms": worst, "expectedPayoutAtoms": expected, "edgeAtoms": edge, "edgeBps": edge_bps}
        if worst > config["maxCostAtoms"]:
            evaluations.append({**evaluated, "status": "budget_exceeded"})
        elif edge_bps < config["minEdgeBps"] or edge < config["minEdgeAtoms"]:
            evaluations.append({**evaluated, "status": "edge_below_threshold"})
        else:
            evaluations.append({**evaluated, "status": "eligible"})
    eligible = [e for e in evaluations if e["status"] == "eligible"]
    if not eligible:
        seen = {e["status"] for e in evaluations}
        return abstain([r for r in ("quote_expired", "quote_unavailable", "budget_exceeded", "edge_below_threshold") if r in seen], evaluations)
    # Largest edge; ties broken by the claim key as a string, ascending.
    best = sorted(eligible, key=lambda e: (-e["edgeAtoms"], claim_key(10143, pool, e["scope"], e["mask"])))[0]
    return {"outcome": "propose", "reasons": [], "evaluations": evaluations,
            "proposal": {"scope": best["scope"], "mask": best["mask"], "quantityAtoms": quantity, "quoteAtoms": best["quoteAtoms"], "worstCostAtoms": best["worstCostAtoms"],
                         "expectedPayoutAtoms": best["expectedPayoutAtoms"], "edgeAtoms": best["edgeAtoms"], "edgeBps": best["edgeBps"], "slippageBps": config["slippageBps"],
                         "forecastPpm": best["forecastPpm"]}}
