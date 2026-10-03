"""Prevent incomplete or mislabelled research results from being reported as evidence."""
import unittest
from parlay_report import report


class ReportTests(unittest.TestCase):
    def fixture(self):
        calibration = "scenario,seed,step,model,mse_all_claims,kl_joint\n"
        for seed in (7, 19, 41):
            for model in ("pairwise_all", "pairwise_singles", "independent_all", "uniform"):
                calibration += f"stationary,{seed},4000,{model},0.01,0.02\n"
        flow = "seed,step,model,mse_all_claims,expected_pnl,min_initial_collateral_observed\n"
        for seed in (7, 19, 41):
            for model in ("flurbo_factored", "pairwise_order_adapter"):
                flow += f"{seed},600,{model},0.03,-2,4\n"
        return calibration, flow

    def test_reports_negative_results_and_explicit_provenance_limits(self):
        text = report(*self.fixture())
        self.assertIn("-2.000000", text)
        self.assertIn("not a reproduction", text)
        self.assertIn("No statistical loss", text)
        self.assertIn("not realised return", text)

    def test_incomplete_or_duplicate_seed_sets_fail(self):
        calibration, flow = self.fixture()
        with self.assertRaises(ValueError):
            report(calibration, flow.replace("41,600", "7,600"))
        with self.assertRaises(ValueError):
            report(calibration.replace("stationary,41", "stationary,7"), flow)


if __name__ == "__main__":
    unittest.main()
