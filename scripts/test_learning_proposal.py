"""Unsigned learning proposal checks: exact quantization, graph gates and provenance."""
import copy
from decimal import Decimal
from fractions import Fraction
import unittest

from build_learning_proposal import build, decimal, digest, rounded, value_at


def fixture(events=2):
    return ({"schema": "flurbo.ising-model.v1", "events": events,
             "parameters": ["0"] * (events * (events + 1) // 2), "source": "synthetic unit test"},
            {"schema": "flurbo.funded-snapshot.v1", "chainId": "31338", "pool": "0x" + "11" * 20,
             "blockNumber": "7", "blockHash": "0x" + "22" * 32, "timestamp": "100", "closesAt": "1000",
             "revision": "1", "events": events, "decimals": 6, "liquidity": "10000000",
             "maxBiasMovement": "2000000", "order": list(range(events)), "factors": [], "biasFactors": []})


def proposal(model, snapshot, **kwargs):
    return build(model, snapshot, max_funding="1000000", deadline="200", **kwargs)


class ProposalTests(unittest.TestCase):
    def test_exact_positive_negative_half_even_and_decimal_domain(self):
        for text, expected in [("0.5", 0), ("1.5", 2), ("2.5", 2), ("-0.5", 0), ("-1.5", -2), ("-2.5", -2)]:
            self.assertEqual(rounded(decimal(text)), expected)
        for invalid in [float("nan"), "NaN", "Infinity", "1e999", "0.1" * 50, "1e-999", "+1", "01"]:
            with self.assertRaises(ValueError):
                decimal(invalid)

    def test_combines_model_and_actual_payouts_without_changing_snapshot(self):
        model, snapshot = fixture()
        model["parameters"] = ["0.073333333333333334", "0.073333333333333334", "0.11"]
        snapshot["factors"] = [{"scope": "3", "values": ["0", "0", "0", "1000000"]}]
        before = copy.deepcopy(snapshot)
        result = proposal(model, snapshot)
        self.assertEqual(snapshot, before)
        self.assertEqual(result, proposal(model, snapshot))
        self.assertEqual(result["proposal"]["bias"], [
            {"scope": "1", "values": ["0", "733333"]},
            {"scope": "2", "values": ["0", "733333"]},
            {"scope": "3", "values": ["0", "0", "0", "100000"]}])
        self.assertLess(Decimal(result["diagnostics"]["totalVariationDecimal80"]), Decimal("0.000001"))
        self.assertEqual(result["modelSha256"], digest(model))
        self.assertEqual(result["snapshotSha256"], digest(snapshot))
        self.assertTrue(result["requiresOnChainSimulation"])

    def test_negative_fields_cancel_liabilities_and_only_add_constants(self):
        model, snapshot = fixture()
        model["parameters"] = ["-0.03", "0.02", "-0.01"]
        snapshot["factors"] = [{"scope": "3", "values": ["100000", "0", "100000", "0"]}]
        result = proposal(model, snapshot)
        biases = {int(r["scope"]): list(map(int, r["values"])) for r in result["proposal"]["bias"]}
        q = {3: [100000, 0, 100000, 0]}
        differences = []
        for state in range(4):
            target = -300000 * (state & 1) + 200000 * ((state >> 1) & 1) - 100000 * (state == 3)
            differences.append(value_at(q, state) + value_at(biases, state) - target)
        self.assertEqual(len(set(differences)), 1)
        self.assertEqual(Fraction(result["diagnostics"]["energyErrorSpanBound"]), 0)

    def test_dense_graph_rejected_even_if_nonzero_edges_quantize_to_zero(self):
        model, snapshot = fixture(4)
        model["parameters"] = ["0"] * 4 + ["1e-20"] * 6
        with self.assertRaisesRegex(ValueError, "width 2"):
            proposal(model, snapshot)

    def test_graph_includes_existing_payouts_not_only_the_model(self):
        model, snapshot = fixture(4)
        # Order 0,1,2,3; model edges 0-1 and 0-2 plus payout edge 0-3 exceed width 2.
        model["parameters"][4:6] = ["0.01", "0.01"]
        snapshot["factors"] = [{"scope": "9", "values": ["0", "0", "0", "100"]}]
        with self.assertRaisesRegex(ValueError, "width 2"):
            proposal(model, snapshot)

    def test_movement_and_quantization_errors_reject_instead_of_clipping(self):
        model, snapshot = fixture()
        model["parameters"][0] = "0.3"
        with self.assertRaisesRegex(ValueError, "movement"):
            proposal(model, snapshot)
        model["parameters"][0] = "0.073333333333333333"
        with self.assertRaisesRegex(ValueError, "quantization"):
            proposal(model, snapshot, max_tv="0")
        model["parameters"][0] = "1e-100"
        with self.assertRaisesRegex(ValueError, "quantization"):
            proposal(model, snapshot, max_tv="0")

    def test_domain_and_snapshot_validation(self):
        model, snapshot = fixture()
        for key, invalid in [("liquidity", "01"), ("liquidity", "0"), ("decimals", 19), ("revision", str(2**256)),
                             ("pool", "0x" + "00" * 20), ("blockHash", "bad"), ("timestamp", "200"),
                             ("closesAt", "200"), ("order", [0, 0]), ("events", 3)]:
            candidate = dict(snapshot, **{key: invalid})
            with self.assertRaises(ValueError, msg=key):
                proposal(model, candidate)
        for parameters in [["0"], ["13", "0", "0"], ["12", "12", "1"]]:
            with self.assertRaises(ValueError):
                proposal(dict(model, parameters=parameters), snapshot)

    def test_malformed_or_duplicate_factors_and_noncanonical_old_bias_reject(self):
        model, snapshot = fixture()
        factor = {"scope": "1", "values": ["0", "1"]}
        for factors in [[factor, factor], [{"scope": "3", "values": ["0", "1"]}],
                        [{"scope": "0", "values": ["0"]}], [{"scope": "1", "values": ["0", "-1"]}]]:
            with self.assertRaises(ValueError):
                proposal(model, dict(snapshot, factors=factors))
        with self.assertRaises(ValueError):
            proposal(model, dict(snapshot, biasFactors=[{"scope": "1", "values": ["1", "2"]}]))


if __name__ == "__main__":
    unittest.main()
