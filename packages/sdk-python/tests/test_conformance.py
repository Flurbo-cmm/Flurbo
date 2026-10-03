"""Conformance: the Python SDK against the shared protocol fixtures (the same files every SDK runs)."""
import json
import unittest
from pathlib import Path

from flurbo_sdk.abi import SELECTORS, decode_call, decode_pool_log, decode_words, encode_call
from flurbo_sdk.amounts import buy_limit, frechet_bounds, joint_from_pair, parse_atoms, percent_to_ppm, sell_minimum, trunc_div, PPM
from flurbo_sdk.claims import claim_key, claim_valid, decode_claim, encode_claim, payout_fraction
from flurbo_sdk.effects import verify_effect
from flurbo_sdk.errors import FlurboError
from flurbo_sdk.policy import effective_policy, evaluate_policy
from flurbo_sdk.recovery import recovery_step
from flurbo_sdk.research import validate_model_output
from flurbo_sdk.strategy import candidate_claims, decide

FIXTURES = Path(__file__).resolve().parents[3] / "protocol" / "fixtures"
POOL = "0x28d5ee02b1eda6959ac3ee5a4f834237c84dee02"


def fixture(name: str) -> dict:
    return json.loads((FIXTURES / f"{name}.json").read_text(encoding="utf-8"))


def ok(fn) -> bool:
    try:
        fn()
        return True
    except FlurboError:
        return False


class Claims(unittest.TestCase):
    def test_claims(self):
        f = fixture("claims")
        for c in f["encode"]:
            self.assertEqual(encode_claim(c["events"], c["legs"], c["rule"]), (c["scope"], c["mask"]), c)
        for c in f["invalidEncode"]:
            self.assertFalse(ok(lambda: encode_claim(c["events"], c["legs"], c["rule"])), c)
        for c in f["validate"]:
            self.assertEqual(claim_valid(c["scope"], c["mask"], c["events"]), c["valid"], c)
        for c in f["decode"]:
            named = decode_claim(c["scope"], c["mask"], c["events"])
            self.assertEqual(named or {"rule": "OTHER", "legs": None}, {"rule": c["rule"], "legs": c["legs"]}, c)
        for k in f["keys"]:
            self.assertEqual(claim_key(k["chainId"], k["pool"], k["scope"], k["mask"]), k["key"])
        for p in f["payouts"]:
            n, d = payout_fraction(p["scope"], int(p["mask"]), p["events"], p["yesMask"], p["voidMask"])
            self.assertEqual([str(n), str(d), str(int(p["quantityAtoms"]) * n // d)], [p["numerator"], p["denominator"], p["payoutAtoms"]], p)


class Calldata(unittest.TestCase):
    def test_calls_returns_events(self):
        f = fixture("calldata")
        for c in f["calls"]:
            self.assertEqual(encode_call(c["function"], c["args"]), c["data"], c)
            name, args = decode_call(c["data"])
            self.assertEqual(name, c["function"])
            self.assertEqual(args, [int(a, 16) if isinstance(a, str) and a.startswith("0x") else int(a) for a in c["args"]])
        self.assertEqual({k: SELECTORS[k] for k in f["selectors"]}, f["selectors"])
        with self.assertRaisesRegex(FlurboError, "length"):
            decode_call(f["calls"][0]["data"] + "00")
        with self.assertRaisesRegex(FlurboError, "Non-canonical"):
            decode_call("0x3e6b6cde" + "f" * 64 + f["calls"][0]["data"][74:])
        with self.assertRaisesRegex(FlurboError, "out of range"):
            encode_call("buy", [3, 8, 1 << 128, 1, 1])
        quote = next(r for r in f["returns"] if r["function"] == "quoteBuy")
        fraction = next(r for r in f["returns"] if r["function"] == "payoutFraction")
        self.assertEqual(str(decode_words(quote["data"], 1)[0]), quote["value"])
        self.assertEqual([str(x) for x in decode_words(fraction["data"], 2)], fraction["value"])
        for e in f["events"]:
            d = decode_pool_log(e)
            flat = {k: (str(v) if k in ("mask", "quantity", "collateralAmount") else v) for k, v in d.items() if k != "address"}
            self.assertEqual(flat, e["decoded"])


class Amounts(unittest.TestCase):
    def test_amounts(self):
        f = fixture("amounts")
        for p in f["parse"]:
            self.assertEqual(ok(lambda: parse_atoms(p["text"])), p["valid"], p)
        for lim in f["limits"]:
            self.assertEqual(str(buy_limit(int(lim["quoteAtoms"]), lim["slippageBps"])), lim["buyLimitAtoms"])
            self.assertEqual(str(sell_minimum(int(lim["quoteAtoms"]), lim["slippageBps"])), lim["sellMinimumAtoms"])
        for e in f["edges"]:
            worst = buy_limit(int(e["quoteAtoms"]), e["slippageBps"])
            expected = int(e["quantityAtoms"]) * int(e["claimPpm"]) // PPM
            edge = expected - worst
            self.assertEqual([str(worst), str(expected), str(edge), str(trunc_div(edge * 10_000, worst))], [e["worstCostAtoms"], e["expectedPayoutAtoms"], e["edgeAtoms"], e["edgeBps"]])
        for p in f["percent"]:
            got = str(percent_to_ppm(p["text"])) if ok(lambda: percent_to_ppm(p["text"])) else None
            self.assertEqual(got, p["ppm"], p)
        for c in f["frechet"]:
            low, high = frechet_bounds(int(c["pA"]), int(c["pB"]))
            self.assertEqual([str(low), str(high)], [c["lowPpm"], c["highPpm"]])
            valid = ok(lambda: joint_from_pair(0, 1, int(c["pA"]), int(c["pB"]), int(c["pBoth"])))
            self.assertEqual(valid, c["valid"])
            if valid:
                self.assertEqual([str(x) for x in joint_from_pair(0, 1, int(c["pA"]), int(c["pB"]), int(c["pBoth"]))[1]], c["statesPpm"])


class Policy(unittest.TestCase):
    def test_policy_and_effective(self):
        f = fixture("policy")
        for c in f["cases"]:
            self.assertEqual(evaluate_policy(c["input"])["violations"], c["expect"], c["name"])
        for e in f["effective"]:
            self.assertEqual(effective_policy(e["local"], e["flurbo"], e["readAt"], e["now"], e["policyMaxAgeSeconds"]), e["expect"], e["name"])


class Recovery(unittest.TestCase):
    def test_transitions_and_effects(self):
        f = fixture("recovery")
        for t in f["transitions"]:
            self.assertEqual(recovery_step(t["entry"], t["chain"], t["now"]), t["expect"], t["name"])
        for e in f["effects"]:
            self.assertEqual(verify_effect(e["intent"], e["receipt"], e["allowanceAfterAtoms"]), e["expect"], e["name"])


class Research(unittest.TestCase):
    def test_model_output_validation(self):
        f = fixture("research")
        for c in f["cases"]:
            r = validate_model_output(c["output"], {**f["context"], **c.get("context", {})})
            got = {"status": "ok", "statesPpm": r["output"]["statesPpm"], "evidenceIds": r["output"]["evidenceIds"]} if r["status"] == "ok" else r
            self.assertEqual(got, c["expect"], c["name"])


class Strategy(unittest.TestCase):
    def test_joint_edge(self):
        f = fixture("strategy")
        for c in f["cases"]:
            cfg = {k: (int(v) if k in ("quantityAtoms", "minEdgeAtoms", "maxCostAtoms") else v) for k, v in c["config"].items()}
            m, fc = c["market"], c["forecast"]
            listed = candidate_claims(m["pool"], m["eventCount"], fc["events"], cfg["includeSingles"])
            self.assertEqual([(s, str(mk)) for s, mk in listed], [(q["scope"], q["mask"]) for q in c["candidates"]], c["name"])
            quotes = {claim_key(10143, m["pool"], q["scope"], q["mask"]): {"amountAtoms": int(q["amountAtoms"]), "expiresAt": q["expiresAt"], "blockHash": m["snapshotBlockHash"]}
                      for q in c["candidates"] if q["amountAtoms"] is not None}
            d = decide(m, {"events": fc["events"], "statesPpm": [int(x) for x in fc["statesPpm"]], "freshEvidence": fc["freshEvidence"]}, cfg, c["now"], quotes)
            p, x = d["proposal"], c["expect"]
            self.assertEqual((d["outcome"], d["reasons"]), (x["outcome"], x["reasons"]), c["name"])
            self.assertEqual({"scope": p["scope"], "mask": str(p["mask"])} if p else None, x["claim"], c["name"])
            if p:
                self.assertEqual([str(p["quoteAtoms"]), str(p["worstCostAtoms"]), str(p["expectedPayoutAtoms"]), str(p["edgeAtoms"]), p["edgeBps"]],
                                 [x["quoteAtoms"], x["worstCostAtoms"], x["expectedPayoutAtoms"], x["edgeAtoms"], x["edgeBps"]], c["name"])
            self.assertEqual([(e["scope"], str(e["mask"]), e["status"], None if e["edgeAtoms"] is None else str(e["edgeAtoms"])) for e in d["evaluations"]],
                             [(e["scope"], e["mask"], e["status"], e["edgeAtoms"]) for e in x["evaluations"]], c["name"])


class Signing(unittest.TestCase):
    def test_transactions_and_messages_match_byte_for_byte(self):
        from flurbo_sdk.runtime.signer import LocalKeySigner, transaction_hash
        f = fixture("calldata")
        for s in f["signing"]:
            signer, t = LocalKeySigner(s["privateKey"]), s["transaction"]
            raw = signer.sign_transaction({"chainId": t["chainId"], "nonce": t["nonce"], "to": t["to"], "data": t["data"], "value": 0, "gas": int(t["gas"]),
                                           "maxFeePerGas": int(t["maxFeePerGas"]), "maxPriorityFeePerGas": int(t["maxPriorityFeePerGas"])})
            self.assertEqual(raw, s["raw"], s["note"])
            self.assertEqual(transaction_hash(raw), s["hash"])
            self.assertEqual(signer.address, s["address"])
        for m in f["messages"]:
            self.assertEqual(LocalKeySigner(m["privateKey"]).sign_message(m["message"]), m["signature"])


if __name__ == "__main__":
    unittest.main()
