"""Regenerate LMSR fixtures with independent 80-digit Decimal cost differences."""
from decimal import Decimal as D, localcontext
from pathlib import Path

CASES = [
    ("uniform_buy", 2, "100", ["0"] * 4, 8, "10"),
    ("uniform_sell", 2, "100", ["10"] * 4, 8, "-10"),
    ("correlated_buy", 2, "100", ["60", "10", "10", "60"], 8, "10"),
    ("correlated_sell", 2, "100", ["60", "10", "10", "60"], 10, "-10"),
    ("three_events", 3, "20", ["1", "2", "3", "4", "5", "6", "7", "8"], 168, "2"),
    ("small_trade", 2, "100", ["0"] * 4, 8, "0.0000001"),
    ("rare_claim", 2, "100", ["10000", "0", "0", "0"], 8, "10"),
    ("likely_sell", 2, "100", ["10000", "10", "10", "10"], 1, "-10"),
]


def render():
    lines = ["name,events,b,q,mask,quantity,cost_delta,probability_after"]
    with localcontext() as ctx:
        ctx.prec = 80
        for name, events, b_text, q_text, mask, quantity_text in CASES:
            b, quantity = D(b_text), D(quantity_text)
            q = list(map(D, q_text))
            after = [value + (quantity if mask & (1 << i) else D(0)) for i, value in enumerate(q)]
            before_sum = sum((value / b).exp() for value in q)
            after_weights = [(value / b).exp() for value in after]
            after_sum = sum(after_weights)
            delta = b * (after_sum.ln() - before_sum.ln())
            probability = sum(w for i, w in enumerate(after_weights) if mask & (1 << i)) / after_sum
            lines.append(f"{name},{events},{b_text},{';'.join(q_text)},{mask},{quantity_text},{delta:.30g},{probability:.30g}")
    return "\n".join(lines) + "\n"


if __name__ == "__main__":
    target = Path(__file__).resolve().parents[1] / "crates/flurbo-core/tests/fixtures/lmsr.csv"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(render(), encoding="utf-8")
