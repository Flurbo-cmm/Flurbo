"""Replacing the reference strategy and research without changing the SDK. The runner accepts any object with
the strategy shape (id, version, decide) or the forecaster shape (kind, name, complete); policy checks,
signing, the journal and recovery stay the SDK's.

    python examples/custom_strategy.py flurbo-agent.json [--once]

This strategy only trades relationships: it ignores single-event claims, requires the forecast to say the
two events are related, and buys the combination with the largest edge per unit of worst-case cost.
"""
import json
import re
import signal
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from flurbo_sdk.amounts import PPM, buy_limit  # noqa: E402
from flurbo_sdk.claims import claim_key, claim_probability, encode_claim, marginal  # noqa: E402
from flurbo_sdk.research import MODEL_SCHEMA  # noqa: E402
from flurbo_sdk.runtime.runner import AgentRunner, parse_config  # noqa: E402


class RelationshipOnly:
    id, version = "relationship-only", "1.0.0"

    def decide(self, ctx: dict) -> dict:
        m, f = ctx["market"], ctx["forecast"]
        a, b = f["events"]
        p_a, p_b = marginal(f["events"], f["statesPpm"], a), marginal(f["events"], f["statesPpm"], b)
        p_ab = f["statesPpm"][3]
        if abs(p_ab - p_a * p_b // PPM) < 50_000:
            return {"outcome": "abstain", "reasons": ["no_relationship_edge"], "explanation": "The forecast treats the events as nearly independent.", "proposal": None}
        claims = [encode_claim(m["eventCount"], [{"event": a, "yes": ya}, {"event": b, "yes": yb}], "AND") for ya in (True, False) for yb in (True, False)]
        claims += [encode_claim(m["eventCount"], [{"event": a, "yes": True}, {"event": b, "yes": True}], r) for r in ("OR", "EXACTLY_ONE")]
        claims = [(s, int(mk)) for s, mk in claims]
        quantity, quotes, best = 1_000_000, ctx["quote"](claims, 1_000_000), None
        for scope, mask in claims:
            q = quotes.get(claim_key(10143, m["pool"], scope, mask))
            if not q:
                continue
            worst = buy_limit(q["amountAtoms"], 50)
            edge = quantity * claim_probability(f["events"], f["statesPpm"], scope, mask) // PPM - worst
            score = edge * 10_000 // worst
            if edge > 20_000 and score >= 1_000 and worst <= 1_500_000 and (not best or score > best[3]):
                best = (scope, mask, q["amountAtoms"], score, edge)
        if not best:
            return {"outcome": "abstain", "reasons": ["edge_below_threshold"], "explanation": "No combination clears 10% edge per unit of worst-case cost.", "proposal": None}
        scope, mask, amount, score, edge = best
        return {"outcome": "propose", "reasons": [], "explanation": f"Relationship trade: edge {edge} atoms, {score} bps of worst-case cost.",
                "proposal": {"scope": scope, "mask": mask, "quantityAtoms": quantity, "quoteAtoms": amount, "slippageBps": 50, "edgeAtoms": edge, "edgeBps": score}}


class KeywordResearch:
    """Custom research (not a language model): keyword rules over the retrieved text. Labelled custom, never AI."""
    kind, name = "custom", "keyword-rules"

    def complete(self, prompt: dict) -> str:
        text, ids = prompt["user"].lower(), re.findall(r'<evidence id="([^"]+)"', prompt["user"])
        tagged, together = len(re.findall(r"tagged|released|published", text)), bool(re.search(r"same day|together|shared", text))
        p_both = min(800_000, 300_000 + tagged * 100_000 + (150_000 if together else 0))
        p_one = (1_000_000 - p_both) // 3
        return json.dumps({"schema": MODEL_SCHEMA, "abstain": not ids, "abstainReason": None if ids else "insufficient_evidence", "events": [0, 1],
                           "statesPpm": [1_000_000 - p_both - 2 * p_one, p_one, p_one, p_both], "evidenceIds": ids[:3], "assumptions": ["Keyword counts reflect release progress."],
                           "uncertainty": "Keyword rules ignore context.", "explanation": f"Rule-based: {tagged} release keywords{', shared schedule' if together else ''}."})


path = Path(sys.argv[1] if len(sys.argv) > 1 else "flurbo-agent.json").resolve()
config = parse_config(json.loads(path.read_text(encoding="utf-8")))
runner = AgentRunner({**config, "stateDir": str((path.parent / config["stateDir"]).resolve())}, strategy=RelationshipOnly(), forecaster=KeywordResearch())
signal.signal(signal.SIGINT, lambda *_: runner.request_stop())
runner.run(once="--once" in sys.argv)
