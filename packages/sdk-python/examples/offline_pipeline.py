"""The autonomous pipeline, offline and deterministic: research -> validated forecast -> strategy ->
deterministic policy -> the transaction that would be signed. No network, no keys, no signer. The forecaster
is a FIXTURE (a fixed reply), not AI; ai_agent.py uses a real model provider.

    python examples/offline_pipeline.py
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from flurbo_sdk.amounts import buy_limit  # noqa: E402
from flurbo_sdk.claims import claim_key  # noqa: E402
from flurbo_sdk.policy import evaluate_policy  # noqa: E402
from flurbo_sdk.research import MODEL_SCHEMA  # noqa: E402
from flurbo_sdk.runtime.research import FixtureForecaster, FixtureRetriever, Researcher  # noqa: E402
from flurbo_sdk.runtime.runner import JointEdgeStrategy, default_config  # noqa: E402
from flurbo_sdk.transaction import build_transaction  # noqa: E402

NOW, POOL = 1_790_500_010, "0x00000000000000000000000000000000f1c7a0e0"
events = [{"index": i, "question": q, "yesRule": "YES if released.", "noRule": "NO otherwise.", "observationEndsAt": 1_791_000_000}
          for i, q in enumerate(["Will project A ship 1.0? (fixture)", "Will project B ship 2.0? (fixture)"])]
retriever = FixtureRetriever([{"id": "src-1", "url": "https://example.org/fixture-release-notes", "title": "Fixture release notes", "publisher": "example.org",
                               "publishedAt": NOW - 3600, "contentSha256": "0" * 64, "excerpt": "Both release branches were tagged on the same day (fixture text)."}])
forecaster = FixtureForecaster(json.dumps({"schema": MODEL_SCHEMA, "abstain": False, "abstainReason": None, "events": [0, 1], "statesPpm": [250_000, 100_000, 100_000, 550_000],
                                           "evidenceIds": ["src-1"], "assumptions": ["The two releases share a dependency."], "uncertainty": "A late fix could split them.",
                                           "explanation": "Fixture reasoning: both branches were tagged together, so both releases are likely and linked."}), "offline-fixture (not AI)")
found = Researcher(retriever, forecaster, 14 * 86_400, 2, 10, now=lambda: NOW).research(POOL, "Fixture market", 2, events, [])
if found["status"] != "ok":
    sys.exit(f"Abstained: {found['reason']}")
print(f"Forecast source: {found['provenance']['kind']} {found['provenance']['name']}; joint ppm {found['output']['statesPpm']}")

# Fixture quotes stand in for pool.quoteBuy: an independent 50/50 market price plus a small spread.
def quote(claims, quantity):
    out = {}
    for scope, mask in claims:
        k = bin(scope).count("1")
        wins = bin(mask).count("1")
        out[claim_key(10143, POOL, scope, mask)] = {"amountAtoms": quantity * wins // 2**k + 20_000, "expiresAt": NOW + 50, "blockHash": "0x" + "f1" * 32}
    return out

market = {"pool": POOL, "eventCount": 2, "open": True, "resolved": False, "closesAt": 1_790_900_000, "snapshotBlockHash": "0x" + "f1" * 32}
forecast = {"events": found["output"]["events"], "statesPpm": found["output"]["statesPpm"], "freshEvidence": found["freshEvidence"]}
decision = JointEdgeStrategy(default_config()["strategy"]).decide({"market": market, "forecast": forecast, "now": NOW, "quote": quote})
print(f"Decision: {decision['outcome']}. {decision['explanation']}")
if not decision["proposal"]:
    sys.exit(0)
p = decision["proposal"]
limit = buy_limit(p["quoteAtoms"], p["slippageBps"])
policy = {**default_config()["policy"], "markets": ["practice-" + POOL[2:]]}
verdict = evaluate_policy({"policy": policy, "now": NOW, "market": {"namespace": "practice-" + POOL[2:], "pool": POOL, "eventCount": 2, "closesAt": 1_790_900_000, "open": True, "resolved": False},
                           "wallet": {"nativeBalanceWei": str(10**18), "holdings": []}, "journal": [],
                           "candidate": {"action": "buy", "namespace": "practice-" + POOL[2:], "claim": {"scope": p["scope"], "mask": str(p["mask"])}, "quantityAtoms": str(p["quantityAtoms"]),
                                         "limitAtoms": str(limit), "slippageBps": p["slippageBps"], "quoteBlockTimestamp": NOW - 5, "gasLimit": "250000", "maxFeePerGas": "100000000000"}})
print("Policy:", "passes" if verdict["ok"] else f"rejected ({', '.join(verdict['violations'])})")
deployment = {"chainId": 10143, "pool": POOL, "eventCount": 2, "closesAt": 1_790_900_000}
tx = build_transaction({"action": "buy", "claim": {"scope": p["scope"], "mask": p["mask"]}, "quantityAtoms": p["quantityAtoms"], "limitAtoms": limit, "deadline": NOW + 300}, deployment, "0x" + "11" * 20)
print(f"Would sign: buy {p['quantityAtoms']} atoms of claim {p['scope']}/{p['mask']}, paying at most {limit} atoms, calldata {tx['data'][:18]}... (offline: nothing signed)")
