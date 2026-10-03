import { randomUUID } from 'node:crypto';
import { FlurboError } from '../errors.ts';
import { verifyEffect } from '../effects.ts';
import { evaluatePolicy, type PolicyConfig, type Violation } from '../policy.ts';
import { recoveryStep } from '../recovery.ts';
import { buyLimit, sellMinimum, COLLATERAL, type Deployment } from '../protocol.ts';
import { buildTransaction, validateTransaction, type Intent } from '../transaction.ts';
import { FileJournal, isFinal, policyEntries, type JournalEntry, type JournalFile } from './journal.ts';
import { transactionHash, type Signer } from './signer.ts';
import type { ChainReader, Block } from './chain.ts';
import { RuntimeApiError, type RuntimeClient } from './headless.ts';
import { semanticError, semanticsDisabled } from '../semantics.ts';

// Live execution (protocol/specs/transactions.md). The order matters for crash safety:
//   plan under the lock (policy check and spend reservation in one step)
//   re-check permission, assign the nonce and sign under the lock, recording the signed bytes
//   broadcast outside the lock; a failure or timeout here is "unknown", never "failed"
//   reconcile from the chain; resend only the identical signed bytes
export type TradeCandidate = {
  decisionId: string; deployment: Deployment; action: 'buy' | 'sell' | 'redeem'; claim: { scope: number; mask: bigint };
  quantityAtoms: bigint; slippageBps: number; quoteAtoms: bigint; quoteBlock: Block;
};
export type ExecutionResult =
  | { status: 'confirmed' | 'reverted' | 'mismatch' | 'replaced' | 'expired' | 'pending'; entryId: string; hash: string | null; costAtoms: string | null }
  | { status: 'rejected_by_policy'; violations: Violation[] }
  | { status: 'blocked'; reason: string }
  | { status: 'simulation_failed' | 'approval_pending' | 'price_moved' | 'quote_unavailable'; detail: string };
export type ExecutorOptions = {
  chain: ChainReader; signer: Signer; journal: FileJournal; client: RuntimeClient | null;
  policy: () => PolicyConfig;                       // effective policy (local tightened by Flurbo)
  liveAllowed: () => { allowed: boolean; reason: string | null };
  now?: () => number; waitSeconds?: number; pollMs?: number; log?: (event: string, detail?: Record<string, unknown>) => void;
  onStop?: (code: string) => void;
};

const MAX_GAS = 15_000_000n;
const reportIntent = (e: JournalEntry) => e.action === 'approve'
  ? { action: 'approve', claim: null, quantityAtoms: '0', limitAtoms: e.limitAtoms, deadline: null }
  : { action: e.action, claim: e.claim, quantityAtoms: e.quantityAtoms, limitAtoms: e.action === 'redeem' ? '0' : e.limitAtoms, deadline: e.action === 'redeem' ? null : e.deadline };

export function executor(o: ExecutorOptions) {
  const now = o.now ?? (() => Math.floor(Date.now() / 1000)), log = o.log ?? (() => {});
  const wallet = o.signer.address, sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
  async function semanticCheck(d: Deployment, scope: number, mask: string, quantityAtoms: string) {
    let reason: string | null = 'SEMANTICS_UNAVAILABLE';
    let disabled = false;
    try { if (o.client) { const r = await o.client.validateTrade(d.namespace,{scope,mask,quantityAtoms}); reason = semanticError(r,{...d,scope,mask,quantityAtoms},now()); disabled = !reason && semanticsDisabled(r); } } catch {}
    if (reason) log(reason, {namespace:d.namespace,scope,mask});
    else if (disabled) log('SEMANTICS_DISABLED', {namespace:d.namespace,scope,mask});
    return reason;
  }

  function intentOf(e: JournalEntry): Intent {
    if (e.action === 'approve') return { action: 'approve', amountAtoms: BigInt(e.limitAtoms) };
    const claim = { scope: e.claim!.scope, mask: BigInt(e.claim!.mask) };
    return e.action === 'redeem' ? { action: 'redeem', claim, quantityAtoms: BigInt(e.quantityAtoms) }
      : { action: e.action, claim, quantityAtoms: BigInt(e.quantityAtoms), limitAtoms: BigInt(e.limitAtoms), deadline: e.deadline! };
  }

  // Everything up to and including the policy check and reservation.
  async function plan(deployment: Deployment, intent: Intent, decisionId: string, quoteBlock: Block | null, slippageBps: number): Promise<{ entry: JournalEntry } | ExecutionResult> {
    const tx = buildTransaction(intent, deployment, wallet);
    try { await o.chain.simulate(wallet, tx.to, tx.data); }
    catch { return { status: 'simulation_failed', detail: 'The transaction would revert at the latest block.' }; }
    let gas: bigint;
    try { gas = (await o.chain.estimateGas(wallet, tx.to, tx.data)) * 120n / 100n; } catch { return { status: 'simulation_failed', detail: 'Gas could not be estimated.' }; }
    if (gas <= 0n || gas > MAX_GAS) return { status: 'simulation_failed', detail: 'Gas is outside the service limit.' };
    const fees = await o.chain.fees(), native = await o.chain.nativeBalance(wallet), head = await o.chain.block();
    const resolved = await o.chain.resolved(deployment.pool);
    const policy = o.policy(), snapshot = o.journal.read();
    const claims = new Map<string, { scope: number; mask: string }>();
    for (const e of snapshot.entries) if (e.claim && e.namespace === deployment.namespace) claims.set(`${e.claim.scope}:${e.claim.mask}`, e.claim);
    if (intent.action !== 'approve') claims.set(`${intent.claim.scope}:${intent.claim.mask}`, { scope: intent.claim.scope, mask: intent.claim.mask.toString() });
    const holdings = await Promise.all([...claims.values()].map(async c => ({ ...c, quantityAtoms: (await o.chain.holdings(deployment.pool, wallet, c.scope, BigInt(c.mask))).toString() })));
    return o.journal.locked((j: JournalFile) => {
      const market = { namespace: deployment.namespace, pool: deployment.pool, eventCount: deployment.eventCount, closesAt: deployment.closesAt,
        open: !resolved && head.timestamp < deployment.closesAt, resolved };
      let violations: Violation[];
      if (intent.action === 'approve') {
        const fee = gas * fees.maxFeePerGas, v = new Set<Violation>();
        if (intent.amountAtoms < 1n || intent.amountAtoms > 100_000_000n) v.add('SERVICE_LIMIT');
        if (!policy.markets.includes(deployment.namespace)) v.add('MARKET_NOT_ALLOWED');
        if (fee > BigInt(policy.gas.maxFeeWei)) v.add('GAS_FEE_LIMIT');
        if (native - fee < BigInt(policy.gas.reserveWei)) v.add('GAS_RESERVE');
        if (j.entries.filter(e => !isFinal(e)).length >= policy.maxPending) v.add('PENDING_LIMIT');
        violations = [...v];
      } else {
        violations = evaluatePolicy({ policy, now: now(), market, wallet: { nativeBalanceWei: native.toString(), holdings }, journal: policyEntries(j),
          candidate: { action: intent.action, namespace: deployment.namespace, claim: { scope: intent.claim.scope, mask: intent.claim.mask.toString() },
            quantityAtoms: intent.quantityAtoms.toString(), limitAtoms: intent.action === 'redeem' ? '0' : intent.limitAtoms.toString(), slippageBps,
            quoteBlockTimestamp: quoteBlock?.timestamp ?? now(), gasLimit: gas.toString(), maxFeePerGas: fees.maxFeePerGas.toString() } }).violations;
      }
      if (violations.length) return { status: 'rejected_by_policy', violations } as ExecutionResult;
      const entry: JournalEntry = { id: randomUUID(), action: intent.action, namespace: deployment.namespace, pool: deployment.pool,
        claim: intent.action === 'approve' ? null : { scope: intent.claim.scope, mask: intent.claim.mask.toString() },
        quantityAtoms: intent.action === 'approve' ? '0' : intent.quantityAtoms.toString(),
        limitAtoms: intent.action === 'approve' ? intent.amountAtoms.toString() : intent.action === 'redeem' ? '0' : intent.limitAtoms.toString(),
        deadline: intent.action === 'buy' || intent.action === 'sell' ? intent.deadline : null, status: 'planned', plannedAt: now(), decisionId,
        to: tx.to, data: tx.data, gas: gas.toString(), maxFeePerGas: fees.maxFeePerGas.toString(), maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(),
        nonce: null, rawTransaction: null, hash: null, signedAt: null, broadcastAt: null, finalAt: null, costAtoms: null, receipt: null, note: null,
        owner: FileJournal.owner(), report: { status: 'none', attempts: 0, flurboStatus: null } };
      j.entries.push(entry);
      return { entry };
    });
  }

  // Signs a planned entry. Returns null if it is no longer planned or live execution is no longer allowed.
  async function sign(entryId: string, deployment: Deployment): Promise<JournalEntry | null> {
    return o.journal.locked(async j => {
      const e = j.entries.find(x => x.id === entryId);
      if (!e || e.status !== 'planned') return null;
      const permission = o.liveAllowed();
      if (!permission.allowed) { Object.assign(e, { status: 'abandoned', finalAt: now(), note: `not signed: ${permission.reason}` }); return null; }
      if (e.action === 'buy') {
        const reason = await semanticCheck(deployment,e.claim!.scope,e.claim!.mask,e.quantityAtoms);
        if (reason) { Object.assign(e,{status:'abandoned',finalAt:now(),note:reason}); return null; }
      }
      validateTransaction({ chainId: 10143, from: wallet, to: e.to, data: e.data, value: 0n }, intentOf(e), deployment, wallet);
      const highest = Math.max(-1, ...j.entries.filter(x => !isFinal(x) && x.nonce !== null).map(x => x.nonce!));
      const nonce = Math.max(await o.chain.nonce(wallet, 'pending'), highest + 1);
      const raw = await o.signer.signTransaction({ chainId: 10143, nonce, to: e.to, data: e.data, value: 0n, gas: BigInt(e.gas!), maxFeePerGas: BigInt(e.maxFeePerGas!), maxPriorityFeePerGas: BigInt(e.maxPriorityFeePerGas!) });
      Object.assign(e, { status: 'signed', nonce, rawTransaction: raw, hash: transactionHash(raw).toLowerCase(), signedAt: now() });
      return { ...e };
    });
  }

  async function broadcast(e: JournalEntry) {
    try {
      await o.chain.sendRaw(e.rawTransaction!);
      await o.journal.locked(j => { const x = j.entries.find(y => y.id === e.id); if (x && x.status === 'signed') Object.assign(x, { status: 'broadcast', broadcastAt: now() }); });
      log('broadcast', { hash: e.hash });
    } catch { log('broadcast_uncertain', { hash: e.hash }); } // Recovery looks the hash up; nothing new is signed.
  }

  // One recovery step for one entry, applied with a compare-and-set on its status.
  async function reconcileEntry(entryId: string): Promise<JournalEntry | null> {
    const e = o.journal.read().entries.find(x => x.id === entryId);
    if (!e || isFinal(e)) return e ?? null;
    // A fresh plan of a live process is its own business; it re-checks its status before signing.
    if (e.status === 'planned' && now() - e.plannedAt < 60 && e.owner.pid !== process.pid) return e;
    const head = await o.chain.block();
    const receipt = e.hash ? await o.chain.receipt(e.hash) : null;
    const txFound = e.hash ? receipt !== null || !!(await o.chain.transaction(e.hash)) : false;
    // A receipt counts once one more block is built on it, the same depth Flurbo's verifier requires.
    const settled = receipt && head.number >= receipt.blockNumber + 1n ? receipt : null;
    const step = recoveryStep({ status: e.status, action: e.action, nonce: e.nonce, deadline: e.deadline },
      { txFound, receiptStatus: settled ? settled.status : null, nonceLatest: await o.chain.nonce(wallet, 'latest') }, head.timestamp);
    let update: Partial<JournalEntry> = {};
    if (step.action === 'verify' && receipt) {
      const allowance = e.action === 'approve' ? (await o.chain.allowance(wallet, e.pool, '0x' + receipt.blockNumber.toString(16))).toString() : null;
      const effect = verifyEffect({ action: e.action, wallet, pool: e.pool, claim: e.claim, quantityAtoms: e.quantityAtoms, limitAtoms: e.action === 'redeem' ? '0' : e.limitAtoms },
        { status: receipt.status, logs: receipt.logs }, allowance);
      update = { status: effect.status, finalAt: now(), costAtoms: effect.status === 'confirmed' ? effect.collateralAtoms : null,
        receipt: { blockNumber: receipt.blockNumber.toString(), gasUsed: receipt.gasUsed.toString(), effectiveGasPrice: receipt.effectiveGasPrice?.toString() ?? null } };
    } else if (step.action === 'release') {
      update = { status: step.status, finalAt: now(), ...(receipt ? { receipt: { blockNumber: receipt.blockNumber.toString(), gasUsed: receipt.gasUsed.toString(), effectiveGasPrice: receipt.effectiveGasPrice?.toString() ?? null } } : {}) };
    } else if (step.action === 'rebroadcast') {
      try { await o.chain.sendRaw(e.rawTransaction!); log('rebroadcast_same_bytes', { hash: e.hash }); } catch { /* still unknown */ }
      return e;
    } else if (step.action === 'poll' && e.status === 'signed') update = { status: 'broadcast', broadcastAt: now() };
    else return e;
    return o.journal.locked(j => {
      const x = j.entries.find(y => y.id === entryId);
      if (!x || x.status !== e.status) return x ?? null;
      Object.assign(x, update);
      return { ...x };
    });
  }

  async function reconcileAll() {
    const open = o.journal.read().entries.filter(e => !isFinal(e));
    const results = [];
    for (const e of open) { try { results.push(await reconcileEntry(e.id)); } catch (err) { log('reconcile_failed', { entry: e.id, code: (err as FlurboError).code }); } }
    return results;
  }

  // Reports every sent transaction to Flurbo, idempotently, and records Flurbo's verification status.
  async function report() {
    if (!o.client) return;
    // Only transactions that reached the network: a replaced or expired one never landed and is not reported.
    const landed = (x: JournalEntry) => !!x.hash && ['broadcast', 'confirmed', 'reverted', 'mismatch'].includes(x.status);
    for (const e of o.journal.read().entries.filter(x => landed(x) && (!['accepted', 'rejected'].includes(x.report.status) || (x.report.status === 'accepted' && !['confirmed', 'reverted', 'mismatch', 'attributed-elsewhere'].includes(x.report.flurboStatus ?? ''))))) {
      try {
        const r = e.report.status === 'accepted' ? await o.client.execution(e.hash!)
          : await o.client.reportExecution({ namespace: e.namespace, hash: e.hash!, intent: reportIntent(e) as never, decisionId: e.decisionId, nonce: e.nonce ?? undefined, sdk: { language: 'typescript', version: '0.2.0' } });
        await o.journal.locked(j => { const x = j.entries.find(y => y.id === e.id); if (x) x.report = { status: 'accepted', attempts: x.report.attempts + 1, flurboStatus: r?.status ?? null }; });
      } catch (err) {
        const api = err instanceof RuntimeApiError ? err : null;
        await o.journal.locked(j => { const x = j.entries.find(y => y.id === e.id); if (x) x.report = { status: api?.apiCode === 'HASH_CONFLICT' ? 'rejected' : 'pending', attempts: x.report.attempts + 1, flurboStatus: api?.apiCode ?? 'NETWORK' }; });
        if (api?.stop) { o.onStop?.(api.apiCode); return; }
      }
    }
  }

  async function wait(entryId: string): Promise<JournalEntry | null> {
    const until = Date.now() + (o.waitSeconds ?? 60) * 1000;
    for (;;) {
      const e = await reconcileEntry(entryId);
      if (!e || isFinal(e) || Date.now() > until) return e;
      await sleep(o.pollMs ?? 1000);
    }
  }

  async function run(deployment: Deployment, intent: Intent, decisionId: string, quoteBlock: Block | null, slippageBps: number): Promise<ExecutionResult> {
    const planned = await plan(deployment, intent, decisionId, quoteBlock, slippageBps);
    if (!('entry' in planned)) return planned;
    const signed = await sign(planned.entry.id, deployment);
    if (!signed) return { status: 'blocked', reason: o.liveAllowed().reason ?? 'not_planned' };
    await broadcast(signed);
    await report();
    const done = await wait(signed.id);
    await report();
    return { status: done && isFinal(done) ? done.status as 'confirmed' : 'pending', entryId: signed.id, hash: signed.hash, costAtoms: done?.costAtoms ?? null };
  }

  async function precheck(deployment: Deployment, intent: Extract<Intent, { action: 'buy' | 'sell' }>, quoteBlock: Block, slippageBps: number): Promise<Violation[]> {
    const resolved = await o.chain.resolved(deployment.pool), head = await o.chain.block(), j = o.journal.read();
    const held = await o.chain.holdings(deployment.pool, wallet, intent.claim.scope, intent.claim.mask);
    const r = evaluatePolicy({ policy: o.policy(), now: now(), market: { namespace: deployment.namespace, pool: deployment.pool, eventCount: deployment.eventCount, closesAt: deployment.closesAt,
      open: !resolved && head.timestamp < deployment.closesAt, resolved }, wallet: { nativeBalanceWei: '0', holdings: [{ scope: intent.claim.scope, mask: intent.claim.mask.toString(), quantityAtoms: held.toString() }] },
      journal: policyEntries(j), candidate: { action: 'buy', namespace: deployment.namespace, claim: { scope: intent.claim.scope, mask: intent.claim.mask.toString() },
        quantityAtoms: intent.quantityAtoms.toString(), limitAtoms: intent.limitAtoms.toString(), slippageBps, quoteBlockTimestamp: quoteBlock.timestamp, gasLimit: '0', maxFeePerGas: '0' } });
    return r.violations.filter(v => !['GAS_FEE_LIMIT', 'GAS_RESERVE'].includes(v));
  }

  async function execute(c: TradeCandidate): Promise<ExecutionResult> {
    const permission = o.liveAllowed();
    if (!permission.allowed) return { status: 'blocked', reason: permission.reason ?? 'blocked' };
    const d = c.deployment, deadlineFor = (b: Block) => Math.min(b.timestamp + 300, d.closesAt - 1);
    if (c.action === 'redeem') return run(d, { action: 'redeem', claim: c.claim, quantityAtoms: c.quantityAtoms }, c.decisionId, null, 0);
    if (c.action === 'sell') return run(d, { action: 'sell', claim: c.claim, quantityAtoms: c.quantityAtoms, limitAtoms: sellMinimum(c.quoteAtoms, c.slippageBps), deadline: deadlineFor(c.quoteBlock) }, c.decisionId, c.quoteBlock, c.slippageBps);
    const semantic = await semanticCheck(d,c.claim.scope,c.claim.mask.toString(),c.quantityAtoms.toString());
    if (semantic) return {status:'blocked',reason:semantic};
    let limit = buyLimit(c.quoteAtoms, c.slippageBps), quoteBlock = c.quoteBlock;
    if (o.journal.read().entries.some(e => e.action === 'approve' && e.pool === d.pool && !isFinal(e))) return { status: 'approval_pending', detail: 'An approval for this pool is still being confirmed.' };
    // Every limit that does not depend on gas is checked before an approval is sent, so a purchase the
    // policy would refuse never causes an approval transaction.
    const early = await precheck(d, { action: 'buy', claim: c.claim, quantityAtoms: c.quantityAtoms, limitAtoms: limit, deadline: deadlineFor(quoteBlock) }, quoteBlock, c.slippageBps);
    if (early.length) return { status: 'rejected_by_policy', violations: early };
    if (await o.chain.allowance(wallet, d.pool) < limit) {
      // A bounded, exact approval for this purchase. It is not spending and is never a standing maximum.
      const approval = await run(d, { action: 'approve', amountAtoms: limit }, c.decisionId, null, 0);
      if (approval.status !== 'confirmed') return approval.status === 'rejected_by_policy' ? approval : { status: 'approval_pending', detail: `Approval ${approval.status}; the purchase waits for the next cycle.` };
      // Re-quote at a newer block. A higher cost is never accepted to force the fill.
      quoteBlock = await o.chain.block();
      const again = await o.chain.quote(d.pool, 'buy', c.claim.scope, c.claim.mask, c.quantityAtoms, quoteBlock);
      if (again === null) return { status: 'quote_unavailable', detail: 'The pool no longer quotes this claim at this size.' };
      if (buyLimit(again, c.slippageBps) > limit) return { status: 'price_moved', detail: 'The price rose after the approval; the next cycle decides again.' };
      limit = buyLimit(again, c.slippageBps);
    }
    return run(d, { action: 'buy', claim: c.claim, quantityAtoms: c.quantityAtoms, limitAtoms: limit, deadline: deadlineFor(quoteBlock) }, c.decisionId, quoteBlock, c.slippageBps);
  }
  return { execute, reconcileAll, reconcileEntry, report, sign, plan, broadcast };
}
export type Executor = ReturnType<typeof executor>;
export const COLLATERAL_ADDRESS = COLLATERAL;
