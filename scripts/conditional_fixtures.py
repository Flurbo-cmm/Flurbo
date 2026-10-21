"""Independent Decimal oracle for conditional claims in liquidity-sensitive pools.

Usage: py scripts/conditional_fixtures.py ../Flurbo-contracts
Writes the Solidity and web fixtures. The internal assertions are the oracle's own tests.
A conditional "if C then T" bought as q shares for a total price r adds q to the states where C and T hold,
0 where C holds and T does not, and r where C fails. The pool accepts r when cost(r) <= r <= q.
"""
import json
import sys
from decimal import Decimal as D, ROUND_CEILING, localcontext
from pathlib import Path

from factored_log_fixtures import stable
from ls_lmsr_fixtures import WAD, depth, liabilities, rate, size

DECIMALS = 6
UNIT = 10**DECIMALS
SCALE = 10**(18 - DECIMALS)
ALLOWANCE_PER_DEPTH = 82048


def bits(scope):
    return [event for event in range(32) if scope & (1 << event)]


def project(union, part, state):
    members = bits(union)
    return sum(((state >> members.index(event)) & 1) << i for i, event in enumerate(bits(part)))


def vector(shape, shares, refund):
    cs, cm, ts, tm = shape
    union = cs | ts
    values = []
    for state in range(1 << size(union)):
        condition = (cm >> project(union, cs, state)) & 1
        target = (tm >> project(union, ts, state)) & 1
        values.append((shares if target else 0) if condition else refund)
    return union, values


def validate(shape, events):
    cs, cm, ts, tm = shape
    union = cs | ts
    ok = cs and ts and not cs & ts and size(cs) <= 2 and size(ts) <= 2 and size(union) <= 3 and union >> events == 0
    ok = ok and 1 <= cm < (1 << (1 << size(cs))) - 1 and 1 <= tm < (1 << (1 << size(ts))) - 1
    assert ok, shape
    return union


def merge(factors, scope, values):
    merged, rest = None, []
    for s, existing in factors:
        if s == scope:
            merged = list(existing)
        else:
            rest.append((s, list(existing)))
    merged = [a + b for a, b in zip(merged or [0] * len(values), values)]
    return rest + [(scope, merged)]


def depth_wad(events, initial_atoms, r, factors):
    wad = [(s, [v * SCALE for v in values]) for s, values in factors]
    if all(isinstance(v, int) for _, values in factors for v in values):
        return depth(initial_atoms * SCALE, r, wad)
    total = sum(D(sum(values)) * (8 >> size(s)) for s, values in wad)
    return D(initial_atoms * SCALE) + D(r) * total / (8 * WAD)


def g_wad(events, initial_atoms, r, factors):
    d = D(depth_wad(events, initial_atoms, r, factors))
    q = liabilities(events, [(s, [D(v) * SCALE for v in values]) for s, values in factors])
    top = max(q)
    return top + d * sum(((v - top) / d).exp() for v in q).ln()


def cost_atoms(m, shape, shares, refund):
    union, values = vector(shape, shares, refund)
    before = g_wad(m['events'], m['initial'], m['rate'], m['factors'])
    after = g_wad(m['events'], m['initial'], m['rate'], merge(m['factors'], union, values))
    return (after - before) / SCALE


def ideal(m, shape, shares, price):
    floor, ceil = stable(lambda: cost_atoms(m, shape, shares, price))
    return ceil


def allowance(m, shape, shares, price):
    union, values = vector(shape, shares, price)
    before = depth_wad(m['events'], m['initial'], m['rate'], m['factors'])
    after = depth_wad(m['events'], m['initial'], m['rate'], merge(m['factors'], union, values))
    up = lambda a: -(-a // SCALE)
    return -(-(up(before) + up(after)) * ALLOWANCE_PER_DEPTH // 10**18) + 3


def fair_price(m, shape, shares):
    """Smallest real price r with cost(r) = r, by bisection, or None when cost(shares) > shares."""
    def solve(precision):
        with localcontext() as context:
            context.prec = precision
            f = lambda r: cost_atoms(m, shape, shares, r) - r
            if f(D(shares)) > 0:
                return None
            low, high = D(0), D(shares)
            assert f(low) > 0
            for _ in range(240):
                middle = (low + high) / 2
                if f(middle) > 0:
                    low = middle
                else:
                    high = middle
            assert abs(f(high)) < D('1e-9'), f(high)
            return high
    result = solve(80)
    other = solve(120)
    assert (result is None) == (other is None)
    assert result is None or sig(result) == sig(other), (result, other)
    return result


def chances(m, shape):
    cs, cm, ts, tm = shape
    events = m['events']
    d = D(depth_wad(events, m['initial'], m['rate'], m['factors']))
    q = liabilities(events, [(s, [D(v) * SCALE for v in values]) for s, values in m['factors']])
    top = max(q)
    weights = [((v - top) / d).exp() for v in q]
    hold = lambda scope, mask, x: (mask >> sum(((x >> e) & 1) << i for i, e in enumerate(bits(scope)))) & 1
    total = sum(weights)
    c = sum(w for x, w in enumerate(weights) if hold(cs, cm, x))
    t = sum(w for x, w in enumerate(weights) if hold(ts, tm, x))
    both = sum(w for x, w in enumerate(weights) if hold(cs, cm, x) and hold(ts, tm, x))
    other = sum(w for x, w in enumerate(weights) if not hold(cs, cm, x) and hold(ts, tm, x))
    return dict(condition=c / total, target=t / total, given=both / c, givenNot=other / (total - c))


def payout(shape, shares, refund, yes_mask, void_mask):
    union, values = vector(shape, shares, refund)
    members = bits(union)
    local_yes = sum(((yes_mask >> e) & 1) << i for i, e in enumerate(members))
    local_void = sum(((void_mask >> e) & 1) << i for i, e in enumerate(members))
    known = ((1 << len(members)) - 1) ^ local_void
    picked = [v for state, v in enumerate(values) if state & known == local_yes & known]
    return sum(picked) // len(picked)


def accepted(m, shape, shares, start):
    price = start
    while ideal(m, shape, shares, price) + allowance(m, shape, shares, price) > price:
        price += 1
        assert price <= shares, 'no accepted price below the shares'
    return price


def samples(m, shape, shares, fair):
    grid = {max(1, shares * i // 50) for i in range(51)}
    if fair is not None:
        centre = int(fair)
        grid |= {p for p in range(centre - 300, centre + 301, 20) if 1 <= p <= shares}
    return [[p, ideal(m, shape, shares, p)] for p in sorted(grid)]


A_YES_B_YES = (1, 2, 2, 2)
A_NO_B_YES = (1, 1, 2, 2)
STATE = [(1, [0, 8 * UNIT]), (3, [0, 0, 0, 6 * UNIT])]
GRAPH = [(scope, [20 * UNIT + ((i * 7 + j * 13) % 43) * UNIT // 10 for j in range(1 << size(scope))])
         for i, scope in enumerate([0, 1, 6, 5, 7]) if scope]


def two(factors):
    return dict(events=2, initial=10 * UNIT, bps=500, rate=rate(2, 500), order=[0, 1], factors=factors)


CASES = [
    ('empty_b_given_a', two([]), A_YES_B_YES, UNIT),
    ('state_b_given_a', two(STATE), A_YES_B_YES, UNIT),
    ('state_b_given_not_a', two(STATE), A_NO_B_YES, UNIT),
    ('state_five_b_given_a', two(STATE), A_YES_B_YES, 5 * UNIT),
    ('three_question_two_target', dict(events=3, initial=100 * UNIT, bps=500, rate=rate(3, 500), order=[2, 0, 1],
                                       factors=GRAPH), (1, 2, 6, 8), 2 * UNIT),
    ('near_certain', two([(3, [0, 0, 0, 60 * UNIT])]), A_YES_B_YES, UNIT),
    ('too_certain', two([(3, [40 * UNIT, 0, 40 * UNIT, 40 * UNIT])]), A_YES_B_YES, UNIT),
]
RESULTS = [('a_yes_b_yes', 3, 0), ('a_yes_b_no', 1, 0), ('a_no', 2, 0), ('a_void_b_yes', 2, 1), ('a_void_b_no', 0, 1)]


def build():
    rows = []
    for name, m, shape, shares in CASES:
        union = validate(shape, m['events'])
        fair = fair_price(m, shape, shares)
        with localcontext() as context:
            context.prec = 80
            before = chances(m, shape)
        row = dict(name=name, market=m, shape=shape, shares=shares, union=union, fair=fair, before=before)
        if fair is None:
            assert name == 'too_certain'
            row['costAtShares'] = ideal(m, shape, shares, shares)
            assert row['costAtShares'] > shares
        else:
            fair_atoms = int(fair.to_integral_value(rounding=ROUND_CEILING))
            price = accepted(m, shape, shares, fair_atoms)
            row.update(fairAtoms=fair_atoms, priceAtoms=price, costAtPrice=ideal(m, shape, shares, price),
                       allowance=allowance(m, shape, shares, price), costBelow=ideal(m, shape, shares, fair_atoms - 2))
            assert row['costAtPrice'] <= price and row['costBelow'] > fair_atoms - 2
            assert ideal(m, shape, shares, fair_atoms) <= fair_atoms
            u, values = vector(shape, shares, price)
            after_factors = merge(m['factors'], u, values)
            row['maxAfter'] = max(liabilities(m['events'], after_factors))
            with localcontext() as context:
                context.prec = 80
                row['after'] = chances(dict(m, factors=after_factors), shape)
                check_monotone(m, shape, shares, fair)
        row['samples'] = samples(m, shape, shares, fair)
        rows.append(row)
    five = next(r for r in rows if r['name'] == 'state_five_b_given_a')
    five['payouts'] = {key: payout(five['shape'], five['shares'], five['priceAtoms'], yes, void)
                       for key, yes, void in RESULTS}
    check_payouts(five)
    check_planning_values(rows)
    return rows


def check_monotone(m, shape, shares, fair):
    """price - cost(price) strictly increases with the price, so the smallest accepted price is unique."""
    grid = [fair * D(k) / 8 for k in range(1, 9)] + [fair + (D(shares) - fair) * D(k) / 8 for k in range(1, 9)]
    gaps = [r - cost_atoms(m, shape, shares, r) for r in grid]
    assert all(b > a for a, b in zip(gaps, gaps[1:])), gaps


def check_payouts(row):
    union, values = vector(row['shape'], row['shares'], row['priceAtoms'])
    for key, yes, void in RESULTS:
        consistent = [v for state, v in enumerate(values)
                      if all(((state >> i) & 1) == ((yes >> e) & 1) for i, e in enumerate(bits(union)) if not (void >> e) & 1)]
        assert row['payouts'][key] == sum(consistent) // len(consistent)
    p = row['payouts']
    assert p['a_yes_b_yes'] == row['shares'] and p['a_yes_b_no'] == 0 and p['a_no'] == row['priceAtoms']
    assert p['a_void_b_yes'] == (row['shares'] + row['priceAtoms']) // 2 and p['a_void_b_no'] == row['priceAtoms'] // 2


def check_planning_values(rows):
    by = {r['name']: r for r in rows}
    assert abs(by['empty_b_given_a']['fair'] / UNIT - D('0.565834')) < D('1e-6'), by['empty_b_given_a']['fair']
    assert abs(by['state_five_b_given_a']['fair'] / UNIT - D('3.6525')) < D('1e-4'), by['state_five_b_given_a']['fair']
    assert abs(by['state_b_given_a']['fair'] / UNIT - D('0.6885')) < D('1e-4')
    assert abs(by['state_b_given_not_a']['fair'] / UNIT - D('0.6119')) < D('1e-4')
    assert abs(by['near_certain']['fair'] / UNIT - D('0.998582')) < D('1e-6')
    five = by['state_five_b_given_a']
    assert abs(five['before']['given'] - D('0.6430')) < D('1e-4') and abs(five['after']['given'] - D('0.7440')) < D('1e-4')
    assert abs(five['before']['condition'] - D('0.7542')) < D('1e-4') and abs(five['after']['condition'] - D('0.7486')) < D('1e-4')
    assert abs(five['after']['condition'] - five['before']['condition']) < D('0.01')
    assert five['after']['given'] - five['before']['given'] > D('0.09')


def sig(value):
    return f'{value:.30g}'


def chance_strings(values):
    return {k: sig(v) for k, v in values.items()}


def solidity(rows):
    lines = ['// SPDX-License-Identifier: UNLICENSED', 'pragma solidity 0.8.28;',
             '// Generated by scripts/conditional_fixtures.py; do not edit.',
             'import {FactoredQuote as Q} from "../src/FactoredQuote.sol";',
             'import {LsQuote as L} from "../src/LsQuote.sol";',
             'import {LsPricer} from "../src/LsPricer.sol";',
             'import {ConditionalShape as S} from "../src/ConditionalShape.sol";', '',
             'library ConditionalFixtureValues {']
    count = 0
    for r in rows:
        key = r['name'].upper()
        names = ['fairAtoms', 'priceAtoms', 'costAtPrice', 'allowance', 'maxAfter'] if r['fair'] is not None else ['costAtShares']
        for field in names:
            constant = ''.join('_' + c if c.isupper() else c.upper() for c in field)
            lines.append(f'    uint128 internal constant {key}_{constant} = {r[field]};')
    five = next(r for r in rows if r['name'] == 'state_five_b_given_a')
    for key, _, _ in RESULTS:
        lines.append(f'    uint128 internal constant PAYOUT_{key.upper()} = {five["payouts"][key]};')
    lines += ['}', '', 'contract ConditionalFixturesTest {', '    LsPricer private pricer;', '',
              '    function setUp() public {', '        pricer = new LsPricer();', '    }']
    for r in rows:
        m, (cs, cm, ts, tm) = r['market'], r['shape']
        lines += [f'    function test_{r["name"]}() public view {{', f'        L.Market memory m = market{r["name"].title().replace("_", "")}();',
                  f'        S.Shape memory shape = S.Shape({cs}, {cm}, {ts}, {tm});']
        if r['fair'] is None:
            lines += [f'        (uint32 scope, uint128[] memory values) = S.vector(shape, {r["shares"]}, {r["shares"]});',
                      '        (uint128 cost,) = pricer.quoteVector(m, scope, values, true);',
                      f'        assert(cost >= {r["costAtShares"]} && cost > {r["shares"]});', '    }']
        else:
            lines += [f'        checkAccepted(m, shape, {r["shares"]}, {r["priceAtoms"]}, {r["costAtPrice"]}, {r["allowance"]}, {r["maxAfter"]});',
                      f'        checkRefused(m, shape, {r["shares"]}, {r["fairAtoms"] - 2}, {r["costBelow"]});', '    }']
        count += 1
        lines += [f'    function market{r["name"].title().replace("_", "")}() private pure returns (L.Market memory m) {{',
                  f'        m.events = {m["events"]}; m.decimals = {DECIMALS}; m.initialDepth = {m["initial"]}; m.rate = L.depthRate({m["events"]}, {m["bps"]});',
                  f'        m.order = new uint8[]({len(m["order"])});']
        lines += [f'        m.order[{i}] = {e};' for i, e in enumerate(m['order']) if e]
        lines.append(f'        m.factors = new Q.Factor[]({len(m["factors"])});')
        for i, (scope, values) in enumerate(m['factors']):
            lines += [f'        m.factors[{i}].scope = {scope};', f'        m.factors[{i}].values = new uint128[]({len(values)});']
            lines += [f'        m.factors[{i}].values[{j}] = {v};' for j, v in enumerate(values) if v]
        lines.append('    }')
    lines += ['    function test_void_payouts() public pure {',
              f'        S.Shape memory shape = S.Shape({", ".join(map(str, five["shape"]))});']
    for key, yes, void in RESULTS:
        lines.append(f'        assert(S.payout(shape, {five["shares"]}, {five["priceAtoms"]}, {yes}, {void}) == {five["payouts"][key]});')
    lines.append('    }')
    count += 1
    lines += [
        '    function checkAccepted(L.Market memory m, S.Shape memory shape, uint128 shares, uint128 price, uint256 ideal, uint256 allowance, uint256 maximum) private view {',
        '        (uint32 scope, uint128[] memory values) = S.vector(shape, shares, price);',
        '        (uint128 cost, uint128 maxAfter) = pricer.quoteVector(m, scope, values, true);',
        '        assert(cost >= ideal && cost - ideal <= allowance && cost <= price);',
        '        assert(maxAfter == maximum);',
        '    }',
        '    function checkRefused(L.Market memory m, S.Shape memory shape, uint128 shares, uint128 price, uint256 ideal) private view {',
        '        (uint32 scope, uint128[] memory values) = S.vector(shape, shares, price);',
        '        (uint128 cost,) = pricer.quoteVector(m, scope, values, true);',
        '        assert(cost >= ideal && cost > price);',
        '    }', '}']
    return '\n'.join(lines) + '\n', count


def legs(scope, mask):
    members = bits(scope)
    if len(members) == 1:
        return [dict(event=members[0], yes=mask == 2)], 'AND'
    for rule, test in [('AND', lambda a, b: a and b), ('OR', lambda a, b: a or b)]:
        for state in range(4):
            yes = [bool(state & 1), bool(state & 2)]
            encoded = sum(1 << s for s in range(4) if test(bool(s & 1) == yes[0], bool(s & 2) == yes[1]))
            if encoded == mask:
                return [dict(event=e, yes=y) for e, y in zip(members, yes)], rule
    raise AssertionError((scope, mask))


def web(rows):
    out = []
    for r in rows:
        m, (cs, cm, ts, tm) = r['market'], r['shape']
        condition, _ = legs(cs, cm)
        target, rule = legs(ts, tm)
        row = dict(name=r['name'], events=m['events'], initialDepthAtoms=str(m['initial']), commissionBps=m['bps'],
                   order=m['order'], factors=[dict(scope=s, values=list(map(str, v))) for s, v in m['factors']],
                   shape=dict(conditionScope=cs, conditionMask=str(cm), targetScope=ts, targetMask=str(tm)),
                   condition=condition, target=target, rule=rule, shares=str(r['shares']),
                   fair=None if r['fair'] is None else sig(r['fair'] / UNIT), before=chance_strings(r['before']),
                   samples=[[str(p), str(c)] for p, c in r['samples']])
        if r['fair'] is None:
            row['costAtSharesAtoms'] = str(r['costAtShares'])
            row['error'] = 'This conditional is too certain to buy'
        else:
            row.update(fairAtoms=str(r['fairAtoms']), priceAtoms=str(r['priceAtoms']), costAtPriceAtoms=str(r['costAtPrice']),
                       allowanceAtoms=str(r['allowance']), after=chance_strings(r['after']))
        if 'payouts' in r:
            row['payouts'] = [dict(result=key, yesMask=yes, voidMask=void, atoms=str(r['payouts'][key])) for key, yes, void in RESULTS]
        out.append(row)
    return json.dumps(out, indent=2) + '\n', len(out)


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit('usage: py scripts/conditional_fixtures.py <contracts checkout>')
    root = Path(__file__).resolve().parents[1]
    contracts = Path(sys.argv[1]).resolve()
    rows = build()
    sol, a = solidity(rows)
    js, b = web(rows)
    (contracts / 'test/ConditionalFixtures.t.sol').write_text(sol, encoding='utf-8', newline='\n')
    (root / 'apps/web/tests/fixtures/conditionals.json').write_text(js, encoding='utf-8', newline='\n')
    print(f'Generated {a} Solidity fixtures and {b} web rows.')
