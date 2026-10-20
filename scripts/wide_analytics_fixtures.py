"""Independent 90-digit Decimal oracle for pools of 5 to 32 questions. Run to regenerate the checked-in fixture.

Enumerated rows are computed by full enumeration of every outcome. Block rows are 32-question pools built from
disjoint pairs, so their values are closed form: each block is enumerated alone and blocks multiply.
Nothing here imports or mirrors the JavaScript or Rust elimination code.
"""
import json
import random
from decimal import Decimal, ROUND_FLOOR, ROUND_HALF_UP, getcontext
from pathlib import Path

getcontext().prec = 90
RULES = ['AND', 'OR', 'EXACTLY_ONE']
TENTH = Decimal('1e-9')


def disp(v):
    x = v * 1000
    frac = x - x.to_integral_value(rounding=ROUND_FLOOR)
    if abs(frac - Decimal('0.5')) < Decimal('1e-30'):
        raise ValueError('value sits on a rounding boundary')
    return int(x.to_integral_value(rounding=ROUND_HALF_UP))


class Enumerated:
    def __init__(self, events, factors, liquidity):
        self.n = events
        members = [[e for e in range(events) if scope >> e & 1] for scope, _ in factors]
        denominator = Decimal(liquidity)
        cache = {}
        self.weights = []
        for x in range(2 ** events):
            score = 0
            for mem, (_, values) in zip(members, factors):
                local = 0
                for bit, e in enumerate(mem):
                    local |= (x >> e & 1) << bit
                score += values[local]
            if score not in cache:
                cache[score] = (Decimal(score) / denominator).exp()
            self.weights.append(cache[score])
        self.total = sum(self.weights)

    def prob(self, evidence):
        mask = want = 0
        for e, y in evidence.items():
            mask |= 1 << e
            want |= int(y) << e
        return sum(w for x, w in enumerate(self.weights) if x & mask == want) / self.total


class Blocks:
    def __init__(self, tables, liquidity):
        denominator = Decimal(liquidity)
        self.n = 2 * len(tables)
        self.blocks = [[(Decimal(v) / denominator).exp() for v in values] for values in tables]

    def prob(self, evidence):
        p = Decimal(1)
        for k, weights in enumerate(self.blocks):
            mask = want = 0
            for i, e in enumerate((2 * k, 2 * k + 1)):
                if e in evidence:
                    mask |= 1 << i
                    want |= int(evidence[e]) << i
            p *= sum(w for x, w in enumerate(weights) if x & mask == want) / sum(weights)
        return p


def pair_values(model, a, b):
    pa, pb = model.prob({a: True}), model.prob({b: True})
    pnb = model.prob({b: False})
    joint = model.prob({a: True, b: True})
    other = model.prob({a: True, b: False})
    values = dict(a=pa, b=pb, joint=joint, givenYes=joint / pb, givenNo=other / pnb,
                  independent=pa * pb, difference=joint - pa * pb)
    displayed = {k: disp(v) for k, v in values.items()}
    if pb < TENTH:
        displayed['givenYes'] = None
    if pnb < TENTH:
        displayed['givenNo'] = None
    return dict(a=a, b=b, displayed=displayed, precise={k: str(v) for k, v in values.items()})


def scenario_values(model, given):
    evidence = {e: y for e, y in given}
    pg = model.prob(evidence)
    yes, given_yes = [], []
    for e in range(model.n):
        yes.append(model.prob({e: True}))
        if e in evidence:
            given_yes.append(Decimal(1 if evidence[e] else 0))
        else:
            given_yes.append(model.prob({**evidence, e: True}) / pg)
    rare = pg < TENTH
    return dict(given=[dict(event=e, yes=y) for e, y in given],
                displayed=dict(given=disp(pg), questions=[
                    dict(event=e, yes=disp(yes[e]), givenYes=None if rare else disp(given_yes[e])) for e in range(model.n)]),
                precise=dict(given=str(pg), yes=[str(v) for v in yes], givenYes=[str(v) for v in given_yes]))


def matches(rule, hits):
    count = sum(hits)
    return count == len(hits) if rule == 'AND' else count > 0 if rule == 'OR' else count == 1


def claim_values(model, legs, rule):
    legs = sorted(legs)
    events = [e for e, _ in legs]
    scope = sum(1 << e for e in events)
    k = len(events)
    mask = 0
    for state in range(2 ** k):
        if matches(rule, [bool(state >> i & 1) == y for i, (_, y) in enumerate(legs)]):
            mask |= 1 << state
    cells = [model.prob({e: bool(state >> i & 1) for i, e in enumerate(events)}) for state in range(2 ** k)]
    marginal = [model.prob({e: True}) for e in events]
    market = sum(cells[s] for s in range(2 ** k) if mask >> s & 1)
    independent = Decimal(0)
    for s in range(2 ** k):
        if mask >> s & 1:
            term = Decimal(1)
            for i in range(k):
                term *= marginal[i] if s >> i & 1 else 1 - marginal[i]
            independent += term
    return dict(scope=scope, mask=str(mask), rule=rule, legs=[dict(event=e, yes=y) for e, y in legs],
                displayed=dict(market=disp(market), independent=disp(independent), difference=disp(market - independent)),
                cells=[disp(c) for c in cells])


def state_of(events, factors, liquidity, a, b):
    return dict(events=events, a=a, b=b, liquidity=str(liquidity), order=list(range(events)),
                factors=[dict(scope=s, values=[str(v) for v in vals]) for s, vals in factors])


def chain_factors(rng, n, liquidity, scale=1):
    factors = []
    draw = lambda: rng.randint(0, 30_000_000) * scale + (rng.randint(0, scale - 1) if scale > 1 else 0)
    for i in range(n - 1):
        if rng.random() < 0.75:
            factors.append(((1 << i) | (1 << i + 1), [draw() for _ in range(4)]))
    for i in range(n - 2):
        if rng.random() < 0.3:
            factors.append(((1 << i) | (1 << i + 1) | (1 << i + 2), [draw() for _ in range(8)]))
    if not factors:
        factors.append((3, [draw() for _ in range(4)]))
    while sum(max(v) for _, v in factors) > 100 * liquidity:
        factors.pop()
    return factors


def legs_for(rng, events):
    return [(e, rng.random() < 0.5) for e in events]


def enumerated_row(name, rng, n, factors, liquidity, a, b, scenarios, claims):
    model = Enumerated(n, factors, liquidity)
    return dict(name=name, kind='enumerated', state=state_of(n, factors, liquidity, a, b),
                pair=pair_values(model, a, b),
                scenarios=[scenario_values(model, g) for g in scenarios],
                claims=[claim_values(model, legs, rule) for legs, rule in claims])


def random_enumerated(name, rng, n, idx, liquidity=10_000_000, scale=1):
    factors = chain_factors(rng, n, liquidity, scale)
    a = rng.randint(0, n - 3)
    b = rng.randint(a + 2, n - 1)
    scenarios = [legs_for(rng, rng.sample(range(n), size)) for size in (1, 2, 3)]
    claims = [(legs_for(rng, rng.sample(range(n), size)), RULES[(idx + j) % 3]) for j, size in enumerate((2, 2, 3, 3))]
    return enumerated_row(name, rng, n, factors, liquidity, a, b, scenarios, claims)


def block_row(name, rng, idx):
    liquidity = 10_000_000
    tables = [[rng.randint(0, 30_000_000) for _ in range(4)] for _ in range(16)]
    factors = [((3 << 2 * k), t) for k, t in enumerate(tables)]
    model = Blocks(tables, liquidity)
    block = lambda k: (2 * k, 2 * k + 1)
    ks = rng.sample(range(16), 6)
    cross = lambda x, y: (rng.choice(block(x)), rng.choice(block(y)))
    a, b = block(ks[0])
    extra = [cross(ks[1], ks[2]), cross(ks[3], ks[4]), (block(ks[5])[0], block(ks[0])[1])]
    three = ([*block(ks[1]), rng.choice(block(ks[2]))] if idx % 2 == 0 else [rng.choice(block(k)) for k in ks[1:4]])
    scenarios = [legs_for(rng, [rng.choice(block(ks[0]))]), legs_for(rng, [rng.choice(block(ks[1])), rng.choice(block(ks[2]))]),
                 legs_for(rng, three)]
    claims = [(legs_for(rng, list(block(ks[3]))), RULES[idx % 3]),
              (legs_for(rng, [rng.choice(block(ks[3])), rng.choice(block(ks[4]))]), RULES[(idx + 1) % 3]),
              (legs_for(rng, [*block(ks[4]), rng.choice(block(ks[5]))]), RULES[(idx + 2) % 3]),
              (legs_for(rng, [rng.choice(block(k)) for k in ks[0:3]]), RULES[idx % 3])]
    return dict(name=name, kind='blocks', state=state_of(32, factors, liquidity, a, b), pair=pair_values(model, a, b),
                morePairs=[pair_values(model, x, y) for x, y in extra],
                scenarios=[scenario_values(model, g) for g in scenarios],
                claims=[claim_values(model, legs, rule) for legs, rule in claims])


def generate():
    rng = random.Random(2026)
    rows = []
    for n in (5, 8, 12, 16):
        for i in range(6):
            rows.append(random_enumerated(f'enumerated-{n}-{i}', rng, n, i))
    rare = [(3, [0, 0, 0, 10 ** 9])]
    rows.append(enumerated_row('rare-assumption', rng, 5, rare, 10_000_000, 0, 3,
                               [[(0, False)], [(0, True), (2, True)], [(1, False), (3, True)]],
                               [([(0, True), (1, True)], 'AND'), ([(0, False), (2, True), (4, False)], 'OR')]))
    rows.append(enumerated_row('rare-pair-condition', rng, 5, [(6, [10 ** 9, 0, 0, 0])], 10_000_000, 1, 3,
                               [[(1, True)], [(2, True), (4, False)], [(1, True), (2, True), (3, False)]],
                               [([(1, True), (2, True)], 'AND'), ([(1, False), (2, False), (4, True)], 'EXACTLY_ONE')]))
    for i in range(6):
        rows.append(block_row(f'blocks-{i}', rng, i))
    for i, scale in enumerate((10 ** 12, 10 ** 30)):
        liquidity = 13_000_000 * scale
        row = random_enumerated(f'ls-{i}', rng, 16, i, liquidity, scale)
        row['kind'] = 'ls'
        rows.append(row)
    return rows


if __name__ == '__main__':
    path = Path(__file__).resolve().parents[1] / 'apps/web/tests/fixtures/wide-analytics.json'
    path.parent.mkdir(parents=True, exist_ok=True)
    rows = generate()
    path.write_text(json.dumps(rows, indent=1) + '\n', encoding='utf-8')
    print(f'Generated {len(rows)} independent wide fixtures')
