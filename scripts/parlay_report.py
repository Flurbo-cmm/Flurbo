"""Run offline Rust comparisons and record reproducible, explicitly synthetic evidence."""

import argparse
import csv
import hashlib
import io
import json
from pathlib import Path
import statistics
import subprocess


ROOT = Path(__file__).resolve().parents[1]


def mean(rows, field):
    return statistics.mean(float(row[field]) for row in rows)


def report(synthetic, flow):
    calibration = list(csv.DictReader(io.StringIO(synthetic)))
    trades = list(csv.DictReader(io.StringIO(flow)))
    lines = [
        "# ParlayMarket comparison: synthetic evidence",
        "",
        "This is an equation-level reference and controlled experiment, not a reproduction "
        "of the paper's published tables or historical dataset. No statistical loss "
        "guarantees are claimed. No contracts or live prices are changed.",
        "",
        "## Target-observation experiment",
        "",
        "Three binary events; seeds 7, 19, 41; 4,000 updates; field/pair learning rates "
        "0.2/0.2; exact enumeration. Metrics below average the three final observations. "
        "Probability targets come from a known synthetic distribution, not an inferred "
        "real trader belief. MSE covers all seven nonempty YES conjunctions.",
        "",
        "| Scenario | Model | Mean MSE | Mean joint KL |",
        "|---|---|---:|---:|",
    ]
    for scenario in sorted({r["scenario"] for r in calibration}):
        for model in ["pairwise_all", "pairwise_singles", "independent_all", "uniform"]:
            rows = [r for r in calibration if r["scenario"] == scenario
                    and r["model"] == model and r["step"] == "4000"]
            if {r["seed"] for r in rows} != {"7", "19", "41"} or len(rows) != 3:
                raise ValueError("incomplete calibration output")
            lines.append(f"| {scenario} | {model} | {mean(rows, 'mse_all_claims'):.8f} "
                         f"| {mean(rows, 'kl_joint'):.8f} |")
    lines += [
        "", "## Same-flow comparison with the existing Flurbo reference", "",
        "Both engines receive the same seeded 600-order stream per seed, with b=10 and "
        "quantities from 0.1 to 0.5. The stream samples YES/NO demand from a fixed "
        "synthetic distribution; it does not model informed trader responses to prices. "
        "A NO purchase is represented by a negative YES signal plus complete-set cash "
        "in the learner, and by a positive complement-claim purchase in FactoredLmsr. "
        "Neither engine can reject orders based on user willingness to pay in this experiment.",
        "",
        "| Model | Final MSE | Expected PnL* | Observed collateral requirement* |",
        "|---|---:|---:|---:|",
    ]
    for model in ["flurbo_factored", "pairwise_order_adapter"]:
        rows = [r for r in trades if r["model"] == model and r["step"] == "600"]
        if {r["seed"] for r in rows} != {"7", "19", "41"} or len(rows) != 3:
            raise ValueError("incomplete flow output")
        lines.append(f"| {model} | {mean(rows, 'mse_all_claims'):.8f} "
                     f"| {mean(rows, 'expected_pnl'):.6f} "
                     f"| {mean(rows, 'min_initial_collateral_observed'):.6f} |")
    lines += [
        "", "*Hypothetical whole collateral units, no fees or gas. Expected PnL is "
        "collected reference trade costs minus terminal liabilities averaged under "
        "the known synthetic truth. It is not realised return. Observed collateral "
        "requirement is max over this path of max terminal payouts minus cumulative "
        "receipts, floored at zero. It is not an ex-ante bound or an LP deposit quote. "
        "Virtual shadow quantities create no payout obligations. Actual liabilities "
        "are independently enumerated and checked against FactoredLmsr each step.",
        "", "## Interpretation and limits", "",
        "Read both probability error and capital metrics: better forecasts do not "
        "automatically mean greater maker profit or lower funding needs. The higher-order "
        "fixture deliberately lies outside the pairwise family. Poisoning and regime "
        "change trajectories are retained in synthetic.csv rather than hidden by final averages.",
        "",
        "Exact inference caps this reference at eight events. Synthetic calibration uses "
        "known targets and the flow/replay mode uses an explicit binary-LMSR target adapter. "
        "These are different observation models. No historical dataset was supplied or "
        "downloaded. Historical reproduction and on-chain execution integration remain pending.",
    ]
    return "\n".join(lines) + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=ROOT / "target" / "parlay-comparison")
    args = parser.parse_args()
    results = {}
    for mode in ("synthetic", "flow"):
        completed = subprocess.run(
            ["cargo", "run", "--offline", "--release", "-p", "flurbo-core",
             "--example", "parlay_compare", "--", mode],
            cwd=ROOT, text=True, capture_output=True, check=True, timeout=120,
        )
        results[mode] = completed.stdout
    summary = report(results["synthetic"], results["flow"])
    # Only write artifacts after both complete successfully and report shape validates.
    args.out.mkdir(parents=True, exist_ok=True)
    for name, content in results.items():
        (args.out / f"{name}.csv").write_text(content, encoding="utf-8", newline="\n")
    (args.out / "REPORT.md").write_text(summary, encoding="utf-8", newline="\n")
    inputs = ["Cargo.lock", "crates/flurbo-core/src/parlay_learning.rs",
              "crates/flurbo-core/src/factored.rs", "crates/flurbo-core/examples/parlay_compare.rs",
              "scripts/parlay_report.py"]
    manifest = {
        "paper": "https://arxiv.org/html/2603.22596v3",
        "paper_tables_reproduced": False,
        "historical_data_used": False,
        "statistical_loss_guarantees_claimed": False,
        "source_sha256": {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in inputs},
        "output_sha256": {name + ".csv": hashlib.sha256(content.encode()).hexdigest() for name, content in results.items()},
        "rustc": subprocess.run(["rustc", "--version"], text=True, capture_output=True, check=True).stdout.strip(),
    }
    (args.out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(args.out / "REPORT.md")


if __name__ == "__main__":
    main()
