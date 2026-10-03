import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { encode, describe, assertClaim, claimKey, payoutFraction, claimFromJSON, parseAtoms, parseDecimal, jointFromPair, frechetBounds,
  encodeCall, decodeCall, decodeWords, decodePoolLog, SELECTORS, verifyEffect, evaluatePolicy, effectivePolicy, recoveryStep, validateModelOutput,
  buyLimit, sellMinimum, PPM } from '../src/index.ts';

// Conformance: the TypeScript reference SDK against the shared protocol fixtures. Every SDK runs the same files.
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../../../protocol/fixtures/${name}.json`, import.meta.url), 'utf8'));
const POOL = '0x28d5ee02b1eda6959ac3ee5a4f834237c84dee02';
const ok = (fn: () => unknown) => { try { fn(); return true; } catch { return false; } };

test('claims: encoding, validation, decoding, identity and payout fractions', () => {
  const f = fixture('claims');
  for (const c of f.encode) {
    const claim = encode(POOL, c.events, c.legs, c.rule);
    assert.deepEqual([claim.scope, claim.mask.toString()], [c.scope, c.mask], JSON.stringify(c));
  }
  for (const c of f.invalidEncode) assert.equal(ok(() => encode(POOL, c.events, c.legs, c.rule)), false, JSON.stringify(c));
  for (const c of f.validate) assert.equal(ok(() => claimFromJSON({ chainId: 10143, pool: POOL, scope: c.scope, mask: c.mask }, c.events)), c.valid, JSON.stringify(c));
  for (const c of f.decode) {
    const named = describe(assertClaim({ chainId: 10143, pool: POOL, scope: c.scope, mask: BigInt(c.mask) }, c.events), c.events);
    assert.deepEqual(named ? { rule: named.rule, legs: named.legs } : { rule: 'OTHER', legs: null }, { rule: c.rule, legs: c.legs });
  }
  for (const k of f.keys) assert.equal(claimKey({ chainId: k.chainId, pool: k.pool.toLowerCase(), scope: k.scope, mask: BigInt(k.mask) }), k.key);
  for (const p of f.payouts) {
    const r = payoutFraction({ chainId: 10143, pool: POOL, scope: p.scope, mask: BigInt(p.mask) }, p.events, { yesMask: p.yesMask, voidMask: p.voidMask });
    assert.deepEqual([r.numerator.toString(), r.denominator.toString(), (BigInt(p.quantityAtoms) * r.numerator / r.denominator).toString()], [p.numerator, p.denominator, p.payoutAtoms]);
  }
});

test('calldata, return data and events match the fixtures byte for byte', () => {
  const f = fixture('calldata');
  for (const c of f.calls) {
    assert.equal(encodeCall(c.function, c.args), c.data, c.function);
    assert.deepEqual(decodeCall(c.data), { name: c.function, args: c.args.map((a: unknown) => (typeof a === 'string' && a.startsWith('0x') ? BigInt(a) : BigInt(a as string))) });
  }
  assert.deepEqual(SELECTORS, { ...SELECTORS, ...f.selectors });
  assert.throws(() => decodeCall(f.calls[0].data + '00'), /length/);
  assert.throws(() => decodeCall('0x3e6b6cde' + 'f'.repeat(64) + f.calls[0].data.slice(74)), /Non-canonical/, 'a uint32 word with high bits set is rejected');
  assert.throws(() => encodeCall('buy', [3, 8n, 1n << 128n, 1n, 1n]), /out of range/);
  const quote = f.returns.find((r: any) => r.function === 'quoteBuy'), fraction = f.returns.find((r: any) => r.function === 'payoutFraction');
  assert.equal(decodeWords(quote.data, 1)[0].toString(), quote.value);
  assert.deepEqual(decodeWords(fraction.data, 2).map(String), fraction.value);
  for (const e of f.events) {
    const d = decodePoolLog(e)!;
    const flat = Object.fromEntries(Object.entries(d).filter(([k]) => k !== 'address').map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v]));
    assert.deepEqual(flat, e.decoded);
  }
});

test('amounts: parsing, limits, edge arithmetic, percentages and joint bounds', () => {
  const f = fixture('amounts');
  for (const p of f.parse) assert.equal(ok(() => parseAtoms(p.text)), p.valid, JSON.stringify(p.text));
  for (const l of f.limits) {
    assert.equal(buyLimit(BigInt(l.quoteAtoms), l.slippageBps).toString(), l.buyLimitAtoms);
    assert.equal(sellMinimum(BigInt(l.quoteAtoms), l.slippageBps).toString(), l.sellMinimumAtoms);
  }
  for (const e of f.edges) {
    const worst = buyLimit(BigInt(e.quoteAtoms), e.slippageBps), expected = BigInt(e.quantityAtoms) * BigInt(e.claimPpm) / PPM, edge = expected - worst;
    assert.deepEqual([worst, expected, edge, edge * 10_000n / worst].map(String), [e.worstCostAtoms, e.expectedPayoutAtoms, e.edgeAtoms, e.edgeBps]);
  }
  const percentToPpm = (text: string) => { const v = parseDecimal(text, 4); if (v > PPM) throw Error('over'); return v.toString(); };
  for (const p of f.percent) assert.equal(ok(() => percentToPpm(p.text)) ? percentToPpm(p.text) : null, p.ppm, p.text);
  for (const c of f.frechet) {
    const b = frechetBounds(BigInt(c.pA), BigInt(c.pB));
    assert.deepEqual([b.low.toString(), b.high.toString()], [c.lowPpm, c.highPpm]);
    const joint = ok(() => jointFromPair({ a: 0, b: 1, pA: BigInt(c.pA), pB: BigInt(c.pB), pBoth: BigInt(c.pBoth) }));
    assert.equal(joint, c.valid);
    if (c.valid) assert.deepEqual(jointFromPair({ a: 0, b: 1, pA: BigInt(c.pA), pB: BigInt(c.pB), pBoth: BigInt(c.pBoth) }).states.map(String), c.statesPpm);
  }
});

test('policy: every case produces exactly the specified violations, and Flurbo policy only tightens', () => {
  const f = fixture('policy');
  for (const c of f.cases) assert.deepEqual(evaluatePolicy(c.input).violations, c.expect, c.name);
  for (const e of f.effective) {
    const r = effectivePolicy(e.local, e.flurbo, e.readAt, e.now, e.policyMaxAgeSeconds);
    assert.deepEqual(r, e.expect, e.name);
  }
});

test('recovery transitions and receipt effects', () => {
  const f = fixture('recovery');
  for (const t of f.transitions) assert.deepEqual(recoveryStep(t.entry, t.chain, t.now), t.expect, t.name);
  for (const e of f.effects) assert.deepEqual(verifyEffect(e.intent, e.receipt, e.allowanceAfterAtoms), e.expect, e.name);
});

test('research: model output validation', () => {
  const f = fixture('research');
  for (const c of f.cases) {
    const r = validateModelOutput(c.output, { ...f.context, ...c.context });
    const got = r.status === 'ok' ? { status: 'ok', statesPpm: r.output.statesPpm.map(Number), evidenceIds: r.output.evidenceIds }
      : { status: 'abstain', reason: r.reason, ...(r.modelReason ? { modelReason: r.modelReason } : {}) };
    assert.deepEqual(got, c.expect, c.name);
  }
});
