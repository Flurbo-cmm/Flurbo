import { encodeFunctionData, formatUnits, getAddress } from 'viem';
import { hybridSettlementCatalog, readHybridSnapshot } from './hybrid-settlement-worker.mjs';
import { hybridMarketService } from './hybrid-market-service.mjs';
import { TEST_AUSD } from './oracle-integration.mjs';
import { certifiedConditional, certifiedScenario } from './pair-math.mjs';
import { isLsPrepared } from '../scripts/prepare-hybrid-pilot.mjs';
import { decodeClaim } from '../shared/claims.mjs';
import { verifiedLsState } from '../shared/ls-lmsr.mjs';
import { COMBINATION_LIMIT_MESSAGE, combinationFits, pilotCashAbi } from '../shared/pilot.mjs';
import { CONDITIONAL_VERSION, LS_PRICER_CODE_HASH, MAX_CONDITIONAL_SHARES, condPoolAbi, conditionalCall, runtimeCodeHash,
  shapeFromAnswers, shapeKey, solveConditionalPrice, validateShape } from '../shared/conditionals.mjs';

export const CONDITIONALS_UNAVAILABLE = 'Conditional markets are unavailable.';
const address = value => /^0x[0-9a-fA-F]{40}$/.test(value || '');
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const tx = (from, to, data) => ({ chainId: 10143, from: getAddress(from), to: getAddress(to), data, value: '0x0' });
const wire = s => ({ conditionScope: s.conditionScope, conditionMask: String(s.conditionMask), targetScope: s.targetScope,
  targetMask: String(s.targetMask) });
const onChain = s => ({ conditionScope: s.conditionScope, conditionMask: BigInt(s.conditionMask), targetScope: s.targetScope,
  targetMask: BigInt(s.targetMask) });

export function conditionalCatalog(value) {
  const invalid = () => Error('Invalid conditional catalog');
  if (!value || typeof value !== 'object' || Object.keys(value).sort().join() !== 'pools,pricer,schema'
    || value.schema !== 'flurbo.conditional-catalog.v1' || !Array.isArray(value.pools) || value.pools.length > 8
    || !(value.pricer === null || address(value.pricer)) || value.pricer === null && value.pools.length) throw invalid();
  try { hybridSettlementCatalog({ schema: 'flurbo.hybrid-catalog.v1', pools: value.pools }); } catch { throw invalid(); }
  if (value.pools.some(pool => pool.conditionalVersion !== CONDITIONAL_VERSION || !isLsPrepared(pool.prepared))) throw invalid();
  return value;
}

export function conditionalMarketService({ catalog, market, source, evidence, origin, command = null, pairModel,
  pricerCodeHash = LS_PRICER_CODE_HASH }) {
  const conditional = conditionalCatalog(catalog), pools = conditional.pools;
  const questions = hybridMarketService({ catalog: { schema: 'flurbo.hybrid-catalog.v1', pools }, market, source, evidence,
    origin, command, ...(pairModel ? { pairModel } : {}) });
  const recordFor = pool => {
    const record = pools.find(item => same(item.pool, pool));
    if (!record) throw Error('Conditional pool not found');
    return record;
  };
  const read = (record, functionName, args = [], blockNumber) => market.readContract({ address: getAddress(record.pool),
    abi: condPoolAbi, functionName, args, ...(blockNumber === undefined ? {} : { blockNumber }) });

  let mismatch = false;
  const verified = new Set(), checks = new Map();
  const unavailable = () => Error(CONDITIONALS_UNAVAILABLE);
  function verify(record) {
    const key = record.pool.toLowerCase();
    if (!checks.has(key)) checks.set(key, (async () => {
      const [code, version, linked] = await Promise.all([market.getBytecode({ address: getAddress(conditional.pricer) }),
        read(record, 'conditionalVersion'), read(record, 'pricer')]);
      if (runtimeCodeHash(code) !== pricerCodeHash || Number(version) !== CONDITIONAL_VERSION || !same(linked, conditional.pricer)) {
        mismatch = true;
        throw unavailable();
      }
      verified.add(key);
    })().catch(error => { if (!mismatch) checks.delete(key); throw error; }));
    return checks.get(key);
  }
  async function ready(record) {
    if (mismatch) throw unavailable();
    await (record ? verify(record) : Promise.all(pools.map(verify)));
  }
  const status = () => mismatch ? 'unavailable' : pools.every(p => verified.has(p.pool.toLowerCase())) ? 'available' : 'unchecked';

  const states = new Map();
  function poolState(record) {
    const key = record.pool.toLowerCase(), now = Date.now(), cached = states.get(key);
    if (cached && cached.until > now) return cached.promise;
    const promise = (async () => {
      const head = await readHybridSnapshot(record, market, { includeStates: false });
      const at = functionName => read(record, functionName, [], head.blockNumber);
      const [liquidity, order, factors, depth, commissionBps] = await Promise.all(['liquidity', 'eliminationOrder', 'factors',
        'depth', 'commissionBps'].map(at));
      const events = record.prepared.draft.events.length, sequence = order.map(Number);
      const verifiedState = verifiedLsState({ initialDepthAtoms: record.prepared.liquidityAtoms, commissionBps: record.prepared.commissionBps },
        { events, a: 0, b: 1, order: sequence, factors, liquidity, commissionBps, depth });
      if (!verifiedState) throw Error('Conditional pool state unavailable');
      const open = !head.resolved && head.now < record.prepared.draft.closesAt;
      return { head, events, open, order: sequence, scopes: factors.map(f => Number(f.scope)),
        state: { events, liquidity: verifiedState.state.liquidity, order: sequence, factors: verifiedState.state.factors } };
    })().catch(error => { states.delete(key); throw error; });
    states.set(key, { promise, until: now + 6_000 });
    return promise;
  }
  async function confirmed(head) {
    const block = await market.getBlock({ blockNumber: head.blockNumber });
    if (!same(block?.hash, head.blockHash)) throw Error('Conditional chances expired');
  }

  function legsOf(value, count) {
    if (!Array.isArray(value) || value.length < 1 || value.length > 2 || !value.every(item => item && typeof item === 'object'
      && Object.keys(item).sort().join() === 'eventIndex,side' && Number.isInteger(item.eventIndex) && item.eventIndex >= 0
      && item.eventIndex < count && ['yes', 'no'].includes(item.side))) throw Error('Invalid conditional');
    return value.map(item => ({ event: item.eventIndex, yes: item.side === 'yes' }));
  }
  function request(record, input, extra = []) {
    const count = record.prepared.draft.events.length;
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !['condition', 'target', ...extra].includes(key))) throw Error('Invalid conditional');
    const condition = legsOf(input.condition, count), target = legsOf(input.target, count);
    const shape = shapeFromAnswers({ events: count, condition, target });
    return { condition, target, shape };
  }
  const sharesOf = (value, minimum = 1_000_000n) => {
    if (typeof value !== 'string' || !/^[1-9]\d{0,7}$/.test(value) || BigInt(value) < minimum || BigInt(value) > MAX_CONDITIONAL_SHARES)
      throw Error('Enter one to twenty shares');
    return BigInt(value);
  };
  const ownerOf = owner => {
    if (!address(owner)) throw Error('Select a MetaMask wallet');
    return getAddress(owner);
  };

  async function list() {
    await ready();
    return { schema: 'flurbo.conditional-directory.v1', pools: pools.map(record => ({ id: record.id, pool: record.pool,
      title: record.prepared.draft.title, questions: record.prepared.draft.events.map(event => event.question),
      closesAt: record.prepared.draft.closesAt })) };
  }

  async function pool(poolAddress) {
    const record = recordFor(poolAddress);
    await ready(record);
    const s = await poolState(record), count = s.events;
    const marginal = certifiedScenario(s.state, [{ event: 0, yes: true }]).questions;
    const [resolvedState, voidMask] = s.head.resolved ? await Promise.all([read(record, 'resolvedState', [], s.head.blockNumber),
      read(record, 'voidMask', [], s.head.blockNumber)]).then(values => values.map(Number)) : [null, null];
    return { schema: 'flurbo.conditional-pool.v1', id: record.id, pool: record.pool, title: record.prepared.draft.title,
      closesAt: record.prepared.draft.closesAt, open: s.open, resolved: s.head.resolved, resolvedState, voidMask,
      observedAt: s.head.now, blockNumber: String(s.head.blockNumber), blockHash: s.head.blockHash,
      combinationLimit: COMBINATION_LIMIT_MESSAGE,
      questions: record.prepared.draft.events.map((event, eventIndex) => ({ eventIndex, question: event.question,
        route: event.route, observationEndsAt: event.observationEndsAt, chance: marginal[eventIndex].yes,
        pairable: Array.from({ length: count }, (_, other) => other).filter(other => other !== eventIndex
          && combinationFits(count, s.order, s.scopes, 2 ** eventIndex + 2 ** other)) })) };
  }

  async function chancesAt(record, input, extra) {
    const asked = request(record, input, extra), s = await poolState(record);
    const certified = certifiedConditional(s.state, asked.condition, asked.target);
    const fits = combinationFits(s.events, s.order, s.scopes, asked.shape.conditionScope + asked.shape.targetScope);
    return { asked, s, certified, fits };
  }

  async function chances(poolAddress, input) {
    const record = recordFor(poolAddress);
    await ready(record);
    const { asked, s, certified, fits } = await chancesAt(record, input);
    await confirmed(s.head);
    return { schema: 'flurbo.conditional-chances.v1', pool: record.pool, shape: wire(asked.shape), key: shapeKey(asked.shape),
      unit: 'tenths_of_percentage_point', values: certified.values, reasons: certified.reasons, pairable: fits,
      open: s.open, blockNumber: String(s.head.blockNumber), blockHash: s.head.blockHash, observedAt: s.head.now };
  }

  async function quoteFor(record, input, owner, extra = ['shares']) {
    const shares = sharesOf(input?.shares);
    const { asked, s, certified, fits } = await chancesAt(record, input, extra);
    if (!s.open) throw Error('Trading is closed');
    if (!fits) throw Error(COMBINATION_LIMIT_MESSAGE);
    const value = key => certified.values[key] === null ? null : certified.values[key] / 1000;
    const shape = onChain(asked.shape);
    const solved = await solveConditionalPrice({ shares, fair: value('given'), conditionChance: value('condition'),
      quote: price => read(record, 'quoteConditionalBuy', [shape, shares, price], s.head.blockNumber).then(BigInt) });
    const margin = solved.price + (solved.price + 199n) / 200n, pay = margin > shares ? shares : margin;
    const wallet = owner === undefined || owner === null ? null : ownerOf(owner);
    const [cash, allowance] = wallet ? await Promise.all([
      market.readContract({ address: getAddress(TEST_AUSD), abi: pilotCashAbi, functionName: 'balanceOf', args: [wallet] }),
      market.readContract({ address: getAddress(TEST_AUSD), abi: pilotCashAbi, functionName: 'allowance', args: [wallet, getAddress(record.pool)] }),
    ]) : [null, null];
    return { schema: 'flurbo.conditional-quote.v1', pool: record.pool, shape: wire(asked.shape), key: shapeKey(asked.shape),
      shares: String(shares), priceAtoms: String(solved.price), payAtoms: String(pay),
      perShare: String((pay * 1_000_000n + shares - 1n) / shares), refundAtoms: String(pay),
      payoffs: { both: String(shares), conditionOnly: '0', refund: String(pay) }, chances: certified.values,
      reasons: certified.reasons, reads: solved.reads, observedAt: s.head.now, blockNumber: String(s.head.blockNumber),
      cashAtoms: cash === null ? null : String(cash), allowanceAtoms: allowance === null ? null : String(allowance) };
  }
  async function quote(poolAddress, input, owner) {
    const record = recordFor(poolAddress);
    await ready(record);
    return quoteFor(record, input, owner, ['shares', 'owner']);
  }

  function guarded(record, plan) {
    const call = conditionalCall({ to: plan.transaction.to, data: plan.transaction.data, pool: record.pool,
      events: record.prepared.draft.events.length });
    if (!call) throw Error('Conditional action unavailable');
    return plan;
  }

  async function holdingFor(record, wallet, shapeInput) {
    const shape = onChain(validateShape(shapeInput, record.prepared.draft.events.length));
    const [shares, refund] = await read(record, 'conditionalHolding', [wallet, shapeKey(shape)]);
    return { shape, shares: BigInt(shares), refund: BigInt(refund) };
  }

  async function prepare(poolAddress, action, input, owner) {
    const record = recordFor(poolAddress);
    const wallet = ownerOf(owner);
    if (!['approve', 'buy', 'sell', 'redeem'].includes(action)) throw Error('Conditional action unavailable');
    await ready(record);
    if (action === 'approve' || action === 'buy') {
      const q = await quoteFor(record, input, wallet), pay = BigInt(q.payAtoms);
      if (action === 'approve') {
        if (BigInt(q.allowanceAtoms) >= pay) throw Error('Approval already covers this trade');
        return guarded(record, { action, amountAtoms: q.payAtoms, quote: q, reason: `Allow up to ${formatUnits(pay, 6)} test AUSD`,
          transaction: tx(wallet, TEST_AUSD, encodeFunctionData({ abi: pilotCashAbi, functionName: 'approve',
            args: [getAddress(record.pool), pay] })) });
      }
      if (BigInt(q.cashAtoms) < pay || BigInt(q.allowanceAtoms) < pay) throw Error('Fund and approve this purchase first');
      const expiresAt = q.observedAt + 120;
      return guarded(record, { action, payAtoms: q.payAtoms, priceAtoms: q.priceAtoms, expiresAt, quote: q,
        reason: `Predict ${formatUnits(BigInt(q.shares), 6)} shares for ${formatUnits(pay, 6)} test AUSD`,
        transaction: tx(wallet, record.pool, encodeFunctionData({ abi: condPoolAbi, functionName: 'buyConditional',
          args: [onChain(q.shape), BigInt(q.shares), pay, BigInt(expiresAt)] })) });
    }
    if (!input || typeof input !== 'object' || Object.keys(input).some(key => !['shape', 'shares'].includes(key)))
      throw Error('Invalid conditional');
    const [head, holding] = await Promise.all([readHybridSnapshot(record, market, { includeStates: false }),
      holdingFor(record, wallet, input.shape)]);
    if (action === 'redeem') {
      if (!head.resolved || holding.shares === 0n) throw Error('Conditional shares are not ready to collect');
      const payout = BigInt(await read(record, 'conditionalPayout', [holding.shape, wallet]));
      return guarded(record, { action, amountAtoms: String(payout), reason: `Collect ${formatUnits(payout, 6)} test AUSD`,
        transaction: tx(wallet, record.pool, encodeFunctionData({ abi: condPoolAbi, functionName: 'redeemConditional',
          args: [holding.shape] })) });
    }
    if (head.resolved || head.now >= record.prepared.draft.closesAt) throw Error('Trading is closed');
    const shares = sharesOf(input.shares, 1n);
    if (shares > holding.shares) throw Error('No conditional holding to sell');
    const [proceeds, refundRemoved] = await read(record, 'quoteConditionalSell', [holding.shape, wallet, shares]);
    const minimum = BigInt(proceeds) - BigInt(proceeds) / 200n, expiresAt = head.now + 120;
    return guarded(record, { action, amountAtoms: String(proceeds), minimumReceivedAtoms: String(minimum),
      refundRemovedAtoms: String(refundRemoved), expiresAt, reason: `Sell for at least ${formatUnits(minimum, 6)} test AUSD`,
      transaction: tx(wallet, record.pool, encodeFunctionData({ abi: condPoolAbi, functionName: 'sellConditional',
        args: [holding.shape, shares, minimum, BigInt(expiresAt)] })) });
  }

  const shapeCache = new Map();
  async function shapesOf(record) {
    const key = record.pool.toLowerCase(), cached = shapeCache.get(key) ?? [];
    const count = Number(await read(record, 'shapeCount'));
    const fresh = await Promise.all(Array.from({ length: count - cached.length }, (_, i) =>
      read(record, 'shapeAt', [BigInt(cached.length + i)])));
    const all = [...cached, ...fresh.map(([shapeKeyValue, shape]) => ({ key: shapeKeyValue, shape: onChain(shape) }))];
    shapeCache.set(key, all);
    return all;
  }

  async function holdings(poolAddress, owner) {
    const record = recordFor(poolAddress);
    if (!address(owner)) throw Error('Invalid wallet address');
    const wallet = getAddress(owner), count = record.prepared.draft.events.length;
    await ready(record);
    const [head, shapes] = await Promise.all([readHybridSnapshot(record, market, { includeStates: false }), shapesOf(record)]);
    const open = !head.resolved && head.now < record.prepared.draft.closesAt;
    const rows = await Promise.all(shapes.map(async ({ key, shape }) => {
      const [shares, refund] = (await read(record, 'conditionalHolding', [wallet, key])).map(BigInt);
      if (shares === 0n) return null;
      const [sell, payout] = await Promise.all([
        open ? read(record, 'quoteConditionalSell', [shape, wallet, shares]).then(([value]) => String(value)).catch(() => null) : null,
        head.resolved ? read(record, 'conditionalPayout', [shape, wallet]).then(String) : null]);
      return { key, shape: wire(shape), condition: decodeClaim(shape.conditionScope, shape.conditionMask, count),
        target: decodeClaim(shape.targetScope, shape.targetMask, count), sharesAtoms: String(shares), refundAtoms: String(refund),
        sellAtoms: sell, payoutAtoms: payout };
    }));
    return { schema: 'flurbo.conditional-holdings.v1', pool: record.pool, wallet, open, resolved: head.resolved,
      observedAt: head.now, holdings: rows.filter(Boolean) };
  }

  const ruleFor = hash => questions.ruleFor(hash);
  return { status, list, pool, chances, quote, prepare, holdings, ruleFor, questions };
}
