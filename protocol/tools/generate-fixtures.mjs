// Generates the derived golden fixtures and ABI fragments from the repository's canonical code:
// claims from apps/web/shared/claims.mjs, ABIs from apps/web/shared/pilot.mjs, encodings and signatures
// through viem. Hand-written fixtures (policy, recovery, research) are not touched.
//   node protocol/tools/generate-fixtures.mjs          write
//   node protocol/tools/generate-fixtures.mjs --check  fail if any generated file would change
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { encodeClaim, decodeClaim, validateClaim, CLAIM_RULES } from '../../apps/web/shared/claims.mjs';
import { pilotPoolAbi, pilotCashAbi, pilotCash } from '../../apps/web/shared/pilot.mjs';
import { payoutFraction, claimKey } from '../../packages/sdk/src/claims.ts';
import { policyFixture, recoveryCases, researchFixture } from './handwritten.mjs';
import { candidateClaims, decide } from '../../packages/sdk/src/strategy.ts';
import { makeForecast } from '../../packages/sdk/src/forecast.ts';

const require = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const viem = await import(pathToFileURL(require.resolve('viem')).href);
const accounts = await import(pathToFileURL(require.resolve('viem/accounts')).href);
const { encodeFunctionData, decodeFunctionResult, encodeAbiParameters, encodeEventTopics, keccak256, toHex, serializeTransaction } = viem;
const root = new URL('../', import.meta.url), check = process.argv.includes('--check');
const POOL = '0x28d5ee02b1eda6959ac3ee5a4f834237c84dee02', WALLET = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
const json = value => JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2) + '\n';

// Claims
function claims() {
  const encode = [], invalidEncode = [];
  for (const events of [2, 3, 4]) {
    for (let scope = 1; scope < 2 ** events; scope++) {
      const selected = [0, 1, 2, 3].filter(i => scope & (1 << i));
      if (selected.length > 3) continue;
      for (let answers = 0; answers < 2 ** selected.length; answers++) {
        const legs = selected.map((event, j) => ({ event, yes: Boolean(answers & (1 << j)) }));
        for (const rule of CLAIM_RULES) {
          if (rule === 'AT_LEAST_TWO' && legs.length < 2) continue;
          let result;
          try { result = encodeClaim({ events, legs, rule }); } catch { invalidEncode.push({ events, legs, rule }); continue; }
          encode.push({ events, legs, rule, scope: result.scope, mask: result.mask });
        }
      }
    }
  }
  invalidEncode.push(
    { events: 3, legs: [{ event: 0, yes: true }, { event: 0, yes: false }], rule: 'AND', note: 'duplicate event' },
    { events: 3, legs: [{ event: 3, yes: true }], rule: 'AND', note: 'event outside the pool' },
    { events: 4, legs: [0, 1, 2, 3].map(event => ({ event, yes: true })), rule: 'AND', note: 'four legs' },
    { events: 3, legs: [{ event: 1, yes: true }], rule: 'AT_LEAST_TWO', note: 'threshold needs two legs' },
    { events: 3, legs: [], rule: 'OR', note: 'no legs' },
    { events: 3, legs: [{ event: 0, yes: true }], rule: 'XOR', note: 'unknown rule' },
  );
  // Legs given out of order encode the same as sorted legs.
  const unordered = encodeClaim({ events: 3, legs: [{ event: 2, yes: false }, { event: 0, yes: true }], rule: 'AND' });
  encode.push({ events: 3, legs: [{ event: 2, yes: false }, { event: 0, yes: true }], rule: 'AND', scope: unordered.scope, mask: unordered.mask, note: 'legs are sorted by event' });
  const validate = [];
  const probe = (scope, mask, events, note) => { let valid = true; try { validateClaim(scope, mask, events); } catch { valid = false; } validate.push({ scope, mask, events, valid, ...(note ? { note } : {}) }); };
  probe(3, '1', 2); probe(3, '14', 2); probe(3, '15', 2, 'pays in every state'); probe(3, '0', 2, 'never pays');
  probe(1, '2', 2); probe(1, '3', 2, 'single event, every state'); probe(4, '1', 2, 'scope outside a two-event pool');
  probe(7, '254', 3); probe(7, '255', 3, 'pays in every state'); probe(15, '1', 4, 'four events'); probe(8, '2', 4);
  probe(3, '01', 2, 'leading zero'); probe(3, '1.0', 2, 'not an integer'); probe(3, '-1', 2, 'negative'); probe(0, '1', 2, 'empty scope');
  probe(3, '1', 5, 'pools have two to four events');
  const decode = [];
  for (const [scope, events] of [[3, 2], [5, 3], [7, 3], [14, 4]]) {
    const k = scope.toString(2).replace(/0/g, '').length;
    for (let mask = 1n; mask < (1n << BigInt(2 ** k)) - 1n; mask++) {
      const named = decodeClaim(scope, String(mask), events);
      decode.push({ scope, mask: String(mask), events, rule: named ? named.rule : 'OTHER', legs: named ? named.legs : null });
    }
  }
  const keys = [{ chainId: 10143, pool: POOL.toUpperCase().replace('0X', '0x'), scope: 3, mask: '8', key: `10143:${POOL}:3:8` }];
  const payouts = [];
  for (const [scope, mask, events, yesMask, voidMask] of [[3, '8', 2, 3, 0], [3, '8', 2, 1, 0], [3, '8', 2, 1, 2], [3, '6', 2, 0, 3], [7, '128', 3, 7, 0],
    [7, '254', 3, 0, 1], [5, '10', 3, 1, 4], [1, '2', 2, 0, 1], [1, '2', 2, 1, 0], [14, '8', 4, 6, 8], [7, '150', 3, 2, 5]]) {
    const f = payoutFraction({ chainId: 10143, pool: POOL, scope, mask: BigInt(mask) }, events, { yesMask, voidMask });
    payouts.push({ scope, mask, events, yesMask, voidMask, numerator: f.numerator, denominator: f.denominator,
      quantityAtoms: '2500000', payoutAtoms: (2_500_000n * f.numerator / f.denominator).toString() });
  }
  for (const k of keys) if (claimKey({ chainId: k.chainId, pool: POOL, scope: k.scope, mask: BigInt(k.mask) }) !== k.key) throw Error('claim key drift');
  return { schema: 'flurbo.protocol-fixture.claims.v1', encode, invalidEncode, validate, decode, keys, payouts };
}

// Calldata, return data, events and signatures
async function calldata() {
  const calls = [];
  const add = (contract, abi, functionName, args, note) => calls.push({ contract, function: functionName, args: args.map(a => (typeof a === 'bigint' ? a.toString() : a)), data: encodeFunctionData({ abi, functionName, args }), ...(note ? { note } : {}) });
  add('pool', pilotPoolAbi, 'buy', [3, 8n, 1_000_000n, 505_000n, 1_790_000_300n]);
  add('pool', pilotPoolAbi, 'buy', [7, 254n, 100_000_000n, 100_000_000n, 1_790_726_399n], 'service maximum quantity and limit');
  add('pool', pilotPoolAbi, 'buy', [1, 2n, 1n, 1n, (1n << 256n) - 1n], 'uint256 maximum deadline encodes exactly');
  add('pool', pilotPoolAbi, 'sell', [5, 10n, 2_500_000n, 1_240_000n, 1_790_000_300n]);
  add('pool', pilotPoolAbi, 'redeem', [14, 8n, 3_000_000n]);
  add('pool', pilotPoolAbi, 'quoteBuy', [3, 8n, 1_000_000n]);
  add('pool', pilotPoolAbi, 'quoteSell', [3, 8n, 1_000_000n]);
  add('pool', pilotPoolAbi, 'holdings', [WALLET, 3, 8n]);
  add('pool', pilotPoolAbi, 'payoutFraction', [3, 8n]);
  for (const fn of ['closesAt', 'eventCount', 'collateral', 'collateralDecimals', 'settlementRulesHash', 'resolved', 'resolvedState', 'voidMask', 'funded']) add('pool', pilotPoolAbi, fn, []);
  add('collateral', pilotCashAbi, 'approve', [POOL, 505_000n]);
  add('collateral', pilotCashAbi, 'allowance', [WALLET, POOL]);
  add('collateral', pilotCashAbi, 'balanceOf', [WALLET]);
  add('collateral', pilotCashAbi, 'decimals', []);
  const returns = [
    { function: 'quoteBuy', data: encodeAbiParameters([{ type: 'uint128' }], [502_345n]), value: '502345' },
    { function: 'payoutFraction', data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [1n, 2n]), value: ['1', '2'] },
    { function: 'decimals', data: encodeAbiParameters([{ type: 'uint8' }], [6]), value: '6' },
    { function: 'resolved', data: encodeAbiParameters([{ type: 'bool' }], [true]), value: true },
  ];
  for (const r of returns) {
    const decoded = decodeFunctionResult({ abi: r.function === 'decimals' ? pilotCashAbi : pilotPoolAbi, functionName: r.function, data: r.data });
    const got = Array.isArray(decoded) ? decoded.map(String) : typeof decoded === 'boolean' ? decoded : String(decoded);
    if (JSON.stringify(got) !== JSON.stringify(r.value)) throw Error('return fixture drift');
  }
  const traded = { address: POOL, topics: encodeEventTopics({ abi: pilotPoolAbi, eventName: 'Traded', args: { trader: WALLET, scope: 3, mask: 8n } }),
    data: encodeAbiParameters([{ type: 'bool' }, { type: 'uint128' }, { type: 'uint128' }], [true, 1_000_000n, 498_765n]),
    decoded: { event: 'Traded', trader: WALLET, scope: 3, mask: '8', isBuy: true, quantity: '1000000', collateralAmount: '498765' } };
  const redeemed = { address: POOL, topics: encodeEventTopics({ abi: pilotPoolAbi, eventName: 'Redeemed', args: { owner: WALLET, scope: 14, mask: 8n } }),
    data: encodeAbiParameters([{ type: 'uint128' }, { type: 'uint128' }], [3_000_000n, 1_500_000n]),
    decoded: { event: 'Redeemed', owner: WALLET, scope: 14, mask: '8', quantity: '3000000', collateralAmount: '1500000' } };
  // Test-only key: the first well-known local development key. Never funded outside local chains.
  const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
  const account = accounts.privateKeyToAccount(TEST_KEY);
  if (account.address.toLowerCase() !== WALLET) throw Error('test key drift');
  const signing = [];
  for (const [tx, note] of [
    [{ chainId: 10143, nonce: 0, to: POOL, data: calls[0].data, value: 0n, gas: 250_000n, maxFeePerGas: 102_000_000_000n, maxPriorityFeePerGas: 2_000_000_000n }, 'buy, first nonce'],
    [{ chainId: 10143, nonce: 41, to: pilotCash, data: calls.find(c => c.function === 'approve').data, value: 0n, gas: 60_000n, maxFeePerGas: 60_000_000_000n, maxPriorityFeePerGas: 1n }, 'approve'],
  ]) {
    const raw = await account.signTransaction({ ...tx, type: 'eip1559' });
    signing.push({ note, privateKey: TEST_KEY, address: WALLET, transaction: { type: 'eip1559', ...tx, value: '0', gas: tx.gas.toString(), maxFeePerGas: tx.maxFeePerGas.toString(), maxPriorityFeePerGas: tx.maxPriorityFeePerGas.toString() },
      unsignedSerialized: serializeTransaction({ ...tx, type: 'eip1559' }), raw, hash: keccak256(raw) });
  }
  const message = 'Flurbo agent wallet association\nOrigin: http://localhost:18767\nMera account: 0x70997970c51812dc3a010c7d01b50e0d17dc79c8\nAgent: 00000000-0000-4000-8000-000000000001\nAgent wallet: 0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266\nChain: Monad testnet (10143)\nNonce: fixture\nIssued: 2026-09-27T00:00:00.000Z\nExpires: 2026-09-27T00:05:00.000Z\nThis proves control of this wallet so Flurbo can attribute its verified agent trades to this agent. It does not move funds, grant Flurbo any authority, or authorize a transaction.';
  const messages = [{ privateKey: TEST_KEY, address: WALLET, message, signature: await account.signMessage({ message }) }];
  return { schema: 'flurbo.protocol-fixture.calldata.v1', pool: POOL, collateral: pilotCash, wallet: WALLET, calls, returns, events: [traded, redeemed], signing, messages,
    selectors: Object.fromEntries(calls.map(c => [c.function, c.data.slice(0, 10)])) };
}

// Amounts and probabilities
function amounts() {
  const ceilDiv = (a, b) => (a + b - 1n) / b;
  const parse = ['0', '1', '100000000', '340282366920938463463374607431768211455', '340282366920938463463374607431768211456', '01', '-1', '1.5', '1e6', '', ' 1', '0x10', '١']
    .map(text => ({ text, valid: /^(0|[1-9][0-9]{0,38})$/.test(text) && BigInt(text) <= (1n << 128n) - 1n, ...(/^(0|[1-9][0-9]{0,38})$/.test(text) && BigInt(text) <= (1n << 128n) - 1n ? { atoms: text } : {}) }));
  const limits = [];
  for (const quote of [0n, 1n, 9_999n, 10_000n, 498_765n, 999_999n, 100_000_000n]) for (const bps of [10, 50, 100]) {
    limits.push({ quoteAtoms: quote.toString(), slippageBps: bps, buyLimitAtoms: ceilDiv(quote * BigInt(10_000 + bps), 10_000n).toString(), sellMinimumAtoms: (quote * BigInt(10_000 - bps) / 10_000n).toString() });
  }
  const edges = [];
  for (const [quantity, p, quote, bps] of [[1_000_000n, 600_000n, 498_765n, 50], [1_000_000n, 450_000n, 498_765n, 50], [2_500_000n, 333_333n, 700_000n, 10], [100_000_000n, 1_000_000n, 99_000_000n, 100], [10_000n, 1n, 1n, 10], [1_000_000n, 0n, 1n, 100]]) {
    const worst = ceilDiv(quote * BigInt(10_000 + bps), 10_000n), expected = quantity * p / 1_000_000n, edge = expected - worst;
    edges.push({ quantityAtoms: quantity.toString(), claimPpm: p.toString(), quoteAtoms: quote.toString(), slippageBps: bps, worstCostAtoms: worst.toString(), expectedPayoutAtoms: expected.toString(), edgeAtoms: edge.toString(), edgeBps: (edge * 10_000n / worst).toString() });
  }
  const percent = [['62.5', '625000'], ['0', '0'], ['100', '1000000'], ['33.3333', '333333'], ['0.0001', '1'], ['100.0001', null], ['12.34567', null], ['-1', null], ['1e2', null], ['.5', null], ['5.', null], ['050', null]]
    .map(([text, ppm]) => ({ text, ppm }));
  const frechet = [];
  for (const [pA, pB, pBoth] of [[600_000n, 550_000n, 150_000n], [600_000n, 550_000n, 149_999n], [600_000n, 550_000n, 550_000n], [600_000n, 550_000n, 550_001n], [200_000n, 300_000n, 0n], [1_000_000n, 1_000_000n, 1_000_000n], [0n, 0n, 0n]]) {
    const low = pA + pB - 1_000_000n > 0n ? pA + pB - 1_000_000n : 0n, high = pA < pB ? pA : pB, valid = pBoth >= low && pBoth <= high;
    frechet.push({ pA: pA.toString(), pB: pB.toString(), pBoth: pBoth.toString(), lowPpm: low.toString(), highPpm: high.toString(), valid,
      ...(valid ? { statesPpm: [1_000_000n - pA - pB + pBoth, pA - pBoth, pB - pBoth, pBoth].map(String) } : {}) });
  }
  return { schema: 'flurbo.protocol-fixture.amounts.v1', parse, limits, edges, percent, frechet };
}

// Receipt effects: whether a mined receipt shows exactly the reported intent (specs/transactions.md).
function effects() {
  const traded = (over = {}) => {
    const a = { trader: WALLET, scope: 3, mask: 8n, isBuy: true, quantity: 1_000_000n, amount: 498_765n, address: POOL, ...over };
    return { address: a.address, topics: encodeEventTopics({ abi: pilotPoolAbi, eventName: 'Traded', args: { trader: a.trader, scope: a.scope, mask: a.mask } }),
      data: encodeAbiParameters([{ type: 'bool' }, { type: 'uint128' }, { type: 'uint128' }], [a.isBuy, a.quantity, a.amount]) };
  };
  const redeemed = (over = {}) => {
    const a = { owner: WALLET, scope: 3, mask: 8n, quantity: 1_000_000n, amount: 500_000n, ...over };
    return { address: POOL, topics: encodeEventTopics({ abi: pilotPoolAbi, eventName: 'Redeemed', args: { owner: a.owner, scope: a.scope, mask: a.mask } }),
      data: encodeAbiParameters([{ type: 'uint128' }, { type: 'uint128' }], [a.quantity, a.amount]) };
  };
  const buy = { action: 'buy', wallet: WALLET, pool: POOL, claim: { scope: 3, mask: '8' }, quantityAtoms: '1000000', limitAtoms: '510000' };
  const sell = { ...buy, action: 'sell', limitAtoms: '490000' };
  const redeem = { ...buy, action: 'redeem', limitAtoms: '0' };
  const approve = { action: 'approve', wallet: WALLET, pool: POOL, claim: null, quantityAtoms: '0', limitAtoms: '510000' };
  const other = '0x1111111111111111111111111111111111111111';
  return [
    ['buy with the expected event', buy, [traded()], null, { status: 'confirmed', collateralAtoms: '498765' }],
    ['buy paying exactly the limit', buy, [traded({ amount: 510_000n })], null, { status: 'confirmed', collateralAtoms: '510000' }],
    ['buy paying above the limit', buy, [traded({ amount: 510_001n })], null, { status: 'mismatch' }],
    ['buy by another trader', buy, [traded({ trader: other })], null, { status: 'mismatch' }],
    ['buy of another claim', buy, [traded({ mask: 4n })], null, { status: 'mismatch' }],
    ['buy of another quantity', buy, [traded({ quantity: 999_999n })], null, { status: 'mismatch' }],
    ['a sell event for a buy', buy, [traded({ isBuy: false })], null, { status: 'mismatch' }],
    ['the event from another contract', buy, [traded({ address: other })], null, { status: 'mismatch' }],
    ['no events', buy, [], null, { status: 'mismatch' }],
    ['sell at or above the minimum', sell, [traded({ isBuy: false, amount: 490_000n })], null, { status: 'confirmed', collateralAtoms: '490000' }],
    ['sell below the minimum', sell, [traded({ isBuy: false, amount: 489_999n })], null, { status: 'mismatch' }],
    ['redemption', redeem, [redeemed()], null, { status: 'confirmed', collateralAtoms: '500000' }],
    ['redemption of another claim', redeem, [redeemed({ scope: 1, mask: 2n })], null, { status: 'mismatch' }],
    ['approval read back', approve, [], '510000', { status: 'confirmed', collateralAtoms: null }],
    ['approval not reflected in the allowance', approve, [], '509999', { status: 'mismatch' }],
  ].map(([name, intent, logs, allowanceAfter, expect]) => ({ name, intent, receipt: { status: 1, logs }, allowanceAfterAtoms: allowanceAfter, expect }));
}

// The reference strategy (joint-edge v1), derived from the TypeScript implementation. Quotes are explicit
// per candidate, so another SDK reproduces the decision from the same inputs.
function strategy() {
  const snapshot = { chainId: 10143, pool: POOL, blockNumber: 70n, blockHash: '0x' + '70'.repeat(32), timestamp: 1_790_000_000 };
  const baseConfig = { quantityAtoms: 1_000_000n, slippageBps: 50, minEdgeBps: 500, minEdgeAtoms: 10_000n, maxCostAtoms: 2_000_000n, minEvidence: 1, maxEvidenceAgeDays: 14, includeSingles: true };
  const market = (eventCount, over = {}) => ({ namespace: 'pilot', pool: POOL, rulesHash: '0x' + '00'.repeat(32), title: 'Fixture', closesAt: 1_790_600_000, open: true, resolved: false,
    events: Array.from({ length: eventCount }, (_, index) => ({ index, id: 'e' + index, question: 'Q' + index, yesRule: 'y', noRule: 'n', observationEndsAt: 1_790_700_000 })),
    snapshot, oneShareBuyAtoms: Array.from({ length: eventCount }, () => ({ yes: null, no: null })), ...over });
  const forecastOf = (events, states, fresh = 1) => makeForecast({ pool: POOL, joint: { events, states: states.map(BigInt) }, assumptions: [], uncertainty: 'fixture', explanation: 'fixture forecast',
    selfReportedConfidence: null, source: { kind: 'fixture', name: 'fixture' }, createdAt: '2026-09-23T00:00:00.000Z',
    evidence: Array.from({ length: fresh }, (_, i) => ({ id: 'e' + i, title: 'Evidence', source: 'fixture', url: null, observedAt: new Date((1_790_000_000 - 3_600) * 1000).toISOString(), note: '' })) });
  // Quote rule for the fixture: the "market" belief (independent 50/50 events) times quantity, plus a spread.
  const quoteFor = (claim, spread = 20_000n) => {
    const k = claim.scope.toString(2).replace(/0/g, '').length, states = 2 ** k;
    let wins = 0n; for (let s = 0; s < states; s++) if (claim.mask & (1n << BigInt(s))) wins++;
    return 1_000_000n * wins / BigInt(states) + spread;
  };
  const cases = [];
  const add = (name, m, f, cfg, now, quote) => {
    const config = { ...baseConfig, ...cfg };
    const claims = candidateClaims(m, f, config), quotes = new Map(), listed = [];
    for (const claim of claims) {
      const q = quote(claim), key = `${claim.chainId}:${claim.pool}:${claim.scope}:${claim.mask}`;
      listed.push({ scope: claim.scope, mask: claim.mask.toString(), amountAtoms: q === null ? null : q.amount.toString(), expiresAt: q?.expiresAt ?? null });
      quotes.set(key, q === null ? { status: 'unavailable', reason: 'quote_unavailable', detail: '' }
        : { status: 'ok', quote: { schema: 'flurbo.agent-quote.v1', claim, side: 'buy', quantityAtoms: config.quantityAtoms, amountAtoms: q.amount, snapshot, expiresAt: q.expiresAt, source: 'pool.quoteBuy' } });
    }
    const d = decide({ market: m, forecast: f, config, now, quotes, implied: null });
    cases.push({ name, market: { pool: POOL, eventCount: m.events.length, open: m.open, resolved: m.resolved, closesAt: m.closesAt, snapshotBlockHash: snapshot.blockHash },
      forecast: { events: f.joint.events, statesPpm: f.joint.states.map(String), freshEvidence: f.evidence.length },
      config: Object.fromEntries(Object.entries(config).map(([k2, v]) => [k2, typeof v === 'bigint' ? v.toString() : v])), now, candidates: listed,
      expect: { outcome: d.outcome, reasons: d.reasons, claim: d.proposal ? { scope: d.proposal.claim.scope, mask: d.proposal.claim.mask.toString() } : null,
        quoteAtoms: d.proposal?.quoteAtoms.toString() ?? null, worstCostAtoms: d.proposal?.worstCostAtoms.toString() ?? null, expectedPayoutAtoms: d.proposal?.expectedPayoutAtoms.toString() ?? null,
        edgeAtoms: d.proposal?.edgeAtoms.toString() ?? null, edgeBps: d.proposal?.edgeBps ?? null,
        evaluations: d.evaluations.map(e => ({ scope: e.claim.scope, mask: e.claim.mask.toString(), status: e.status, edgeAtoms: e.edgeAtoms?.toString() ?? null })) } });
  };
  const fresh = claim => ({ amount: quoteFor(claim), expiresAt: 1_790_000_060 });
  add('related events: the joint combination has the edge', market(2), forecastOf([0, 1], [50_000, 50_000, 50_000, 850_000]), {}, 1_790_000_010, fresh);
  add('independent forecast near the market: abstain', market(2), forecastOf([0, 1], [250_000, 250_000, 250_000, 250_000]), {}, 1_790_000_010, fresh);
  add('negative relationship: exactly one pays', market(2), forecastOf([0, 1], [50_000, 450_000, 450_000, 50_000]), {}, 1_790_000_010, fresh);
  add('three-event pool, forecast over events 0 and 2', market(3), forecastOf([0, 2], [100_000, 100_000, 100_000, 700_000]), {}, 1_790_000_010, fresh);
  add('without singles', market(2), forecastOf([0, 1], [50_000, 50_000, 50_000, 850_000]), { includeSingles: false }, 1_790_000_010, fresh);
  add('budget below every worst case', market(2), forecastOf([0, 1], [50_000, 50_000, 50_000, 850_000]), { maxCostAtoms: 100_000n }, 1_790_000_010, fresh);
  add('quotes expired', market(2), forecastOf([0, 1], [50_000, 50_000, 50_000, 850_000]), {}, 1_790_000_060, fresh);
  add('quotes unavailable', market(2), forecastOf([0, 1], [50_000, 50_000, 50_000, 850_000]), {}, 1_790_000_010, () => null);
  add('some quotes unavailable', market(2), forecastOf([0, 1], [50_000, 50_000, 50_000, 850_000]), {}, 1_790_000_010, c => (c.scope === 3 ? null : fresh(c)));
  add('not enough fresh evidence', market(2), forecastOf([0, 1], [50_000, 50_000, 50_000, 850_000], 0), {}, 1_790_000_010, fresh);
  add('market closed', market(2, { open: false }), forecastOf([0, 1], [50_000, 50_000, 50_000, 850_000]), {}, 1_790_000_010, fresh);
  add('equal edges: the lower claim key wins', market(2), forecastOf([0, 1], [500_000, 0, 0, 500_000]), { minEdgeBps: 0, minEdgeAtoms: 0n }, 1_790_000_010, c => ({ amount: 100_000n, expiresAt: 1_790_000_060 }));
  add('high thresholds', market(2), forecastOf([0, 1], [50_000, 50_000, 50_000, 850_000]), { minEdgeBps: 9_000, slippageBps: 100, quantityAtoms: 2_000_000n }, 1_790_000_010, c => ({ amount: quoteFor(c) * 2n, expiresAt: 1_790_000_060 }));
  return { schema: 'flurbo.protocol-fixture.strategy.v1', strategy: 'joint-edge', version: '1.0.0', cases };
}

async function emit(path, content) {
  const url = new URL(path, root);
  if (check) {
    const current = await readFile(url, 'utf8').catch(() => null);
    if (current?.replace(/\r\n/g, '\n') !== content) { console.error(`out of date: protocol/${path}`); process.exitCode = 1; }
    return;
  }
  await mkdir(new URL('.', url), { recursive: true });
  await writeFile(url, content);
}
const abiJson = abi => json(abi.map(item => ({ ...item })));
await emit('abi/pilot-pool.v1.json', abiJson(pilotPoolAbi));
await emit('abi/erc20.v1.json', abiJson(pilotCashAbi));
await emit('fixtures/claims.json', json(claims()));
await emit('fixtures/calldata.json', json(await calldata()));
await emit('fixtures/amounts.json', json(amounts()));
await emit('fixtures/policy.json', json(policyFixture()));
await emit('fixtures/recovery.json', json({ schema: 'flurbo.protocol-fixture.recovery.v1', transitions: recoveryCases(), effects: effects() }));
await emit('fixtures/research.json', json(researchFixture()));
await emit('fixtures/strategy.json', json(strategy()));
if (!check) console.log('fixtures written');
