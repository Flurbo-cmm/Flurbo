"""Independent 90-digit Decimal oracle. Run to regenerate the checked-in fixture."""
import json
import random
from decimal import Decimal, localcontext, ROUND_HALF_UP
from pathlib import Path


def fixture(name, events, factors, liquidity=10_000_000, a=0, b=1):
    state = dict(events=events, a=a, b=b, liquidity=str(liquidity),
                 order=list(range(events)), factors=[dict(scope=s, values=list(map(str, v))) for s, v in factors])
    with localcontext() as ctx:
        ctx.prec = 90
        weights = []
        for x in range(2**events):
            score = 0
            for scope, values in factors:
                local, bit = 0, 0
                for event in range(events):
                    if scope & (1 << event):
                        local |= ((x >> event) & 1) << bit
                        bit += 1
                score += values[local]
            weights.append((Decimal(score) / Decimal(liquidity)).exp())
        total = sum(weights)
        select = lambda test: sum(w for x, w in enumerate(weights) if test(x))
        wa, wb = select(lambda x: x & (1 << a)), select(lambda x: x & (1 << b))
        wnb = select(lambda x: not x & (1 << b))
        joint = select(lambda x: x & (1 << a) and x & (1 << b))
        other = select(lambda x: x & (1 << a) and not x & (1 << b))
        pa, pb = wa / total, wb / total
        values = dict(a=pa, b=pb, joint=joint / total, givenYes=joint / wb, givenNo=other / wnb,
                      independent=pa * pb, difference=joint / total - pa * pb)
        displayed = {k: int((v * 1000).to_integral_value(rounding=ROUND_HALF_UP)) for k, v in values.items()}
        if pb < Decimal('1e-9'):
            displayed['givenYes'] = None
        if wnb / total < Decimal('1e-9'):
            displayed['givenNo'] = None
        return dict(name=name, state=state, precise={k: str(v) for k, v in values.items()}, displayed=displayed)


def generate():
    rows = [fixture('uniform-four', 4, []),
            fixture('positive-relationship', 2, [(3, [0, 0, 0, 10_000_000])]),
            fixture('negative-relationship', 2, [(3, [0, 10_000_000, 10_000_000, 0])]),
            fixture('rare-yes', 4, [(2, [1_000_000_000, 0])]),
            fixture('rare-no', 4, [(2, [0, 1_000_000_000])]),
            fixture('both-rare', 2, [(3, [1_000_000_000, 0, 0, 0])]),
            fixture('large-integer-atoms', 2, [(3, [0, 1, 0, 10**37+1])], 10**37),
            fixture('non-adjacent', 4, [(3, [0, 0, 0, 10_000_000]), (6, [0, 0, 0, 10_000_000]), (12, [0, 0, 0, 10_000_000])], a=0, b=3)]
    rng = random.Random(143)
    for i in range(32):
        n = rng.randint(2, 4)
        factors = [(3 << j, [rng.randint(0, 30_000_000) for _ in range(4)]) for j in range(n-1)]
        a, b = rng.sample(range(n), 2)
        rows.append(fixture(f'chain-{i}', n, factors, a=a, b=b))
    return rows


if __name__ == '__main__':
    path = Path(__file__).resolve().parents[1] / 'apps/web/tests/fixtures/pair-analytics.json'
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(generate(), indent=2) + '\n', encoding='utf-8')
    print(f'Generated {len(generate())} independent fixtures')
