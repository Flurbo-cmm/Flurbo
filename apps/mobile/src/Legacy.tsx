import { useEffect, useState, useSyncExternalStore } from 'react';
import { formatUnits } from 'viem';
import { prepare, prepareRedemption, prepareConversion, prepareWithdrawal } from '../../dashboard/wallet.mjs';
import { amount, describeClaim, describeClaimAnswers, type Portfolio } from '../../web/src/portfolio';
import { auth } from './runtime';
import { externalWallet, legacyProvider, type WalletKind } from './wallet';
import { operations } from './operations';
import { api } from './api';
import { useRequest } from './hooks';
import { makeClaim, quantityAtoms } from './market-model';
import { Button, Card, Choice, Copy, External, Field, Heading, Notice, Title } from './ui';

export function Legacy({ kind, initialAction = 'buy' }: { kind: WalletKind; initialAction?: string }) {
  const login = useSyncExternalStore(auth.subscribe, auth.getSnapshot), wallet = useSyncExternalStore(externalWallet.subscribe, externalWallet.getSnapshot), operation = useSyncExternalStore(operations.subscribe, operations.getSnapshot);
  const owner = wallet.address;
  const [market, setMarket] = useState<'original' | 'learning'>('original'), [action, setAction] = useState(initialAction), [quantity, setQuantity] = useState('1'), [recipient, setRecipient] = useState('');
  const [answers, setAnswers] = useState<Record<number, boolean>>({ 7: true }), [mode, setMode] = useState<'all' | 'any'>('all'), [clock, setClock] = useState(Date.now());
  const reviewed = useRequest<{ plan: any; snapshot: any }>(), portfolio = useRequest<Portfolio>();
  const [page, setPage] = useState(0);
  const base = market === 'learning' ? '/api/markets/learning' : '/api';
  useEffect(() => { reviewed.cancel(true); portfolio.cancel(true); setPage(0); }, [owner, market]);
  useEffect(() => { reviewed.cancel(true); }, [action, quantity, recipient, answers, mode, kind]);
  useEffect(() => { const timer = setInterval(() => setClock(Date.now()), 1000); return () => clearInterval(timer); }, []);
  async function review() {
    if (!owner) return;
    await reviewed.run(async signal => {
      const { scope, mask } = makeClaim(answers, mode), units = quantityAtoms(quantity), p = legacyProvider(kind, market);
      try {
        const snapshot = await api<any>(`${base}/state?wallet=${owner}&claims=${scope}:${mask}`, undefined, signal);
        let plan;
        if (action === 'withdraw') plan = await prepareWithdrawal(p, snapshot, owner, recipient, units);
        else if (action === 'wrap' || action === 'unwrap') plan = await prepareConversion(p, snapshot, action, owner, units);
        else if (action === 'redeem') plan = await prepareRedemption(p, snapshot, { scope, mask: Number(mask) }, owner, units);
        else {
          const quote = await api<any>(`${base}/quote?side=${action}&scope=${scope}&mask=${mask}&quantity=${units}`, undefined, signal);
          if (quote.quote?.scope !== scope || String(quote.quote?.mask) !== mask || quote.quote?.quantity_atoms !== units || quote.quote?.side !== action) throw new Error('Quote differs from your selection.');
          plan = await prepare(p, snapshot, quote, owner, 50);
        }
        return { plan, snapshot };
      } finally { p.destroy(); }
    }, true);
  }
  const readPortfolio = (next = page) => owner && void portfolio.run(async signal => {
    const data = await api<Portfolio>(`${base}/portfolio?wallet=${owner}&page=${next}&history_page=${next}`, undefined, signal);
    if (data.wallet_address !== owner.toLowerCase() || data.market_id !== market) throw new Error('Portfolio belongs to another wallet or pool.');
    setPage(next); return data;
  }, true);
  const plan = reviewed.value?.plan;
  return <><Title>{initialAction === 'withdraw' ? 'Withdraw AUSD.' : 'Earlier pools.'}</Title><Copy>Original and learning test pools have separate positions. Their A to H questions are synthetic test fixtures.</Copy>
    <Choice value={market} options={[{ value: 'original', label: 'Original pool' }, { value: 'learning', label: 'Learning pool' }]} onChange={setMarket} />
    <Card><Heading>Action</Heading><Choice value={action} options={['buy', 'sell', 'redeem', 'withdraw', ...(market === 'original' ? ['wrap', 'unwrap'] : [])].map(value => ({ value, label: ({ redeem: 'Claim payout', withdraw: 'Withdraw AUSD', wrap: 'Wrap H Yes', unwrap: 'Unwrap H Yes' } as Record<string, string>)[value] ?? value }))} onChange={setAction} />
      {!['withdraw', 'wrap', 'unwrap'].includes(action) && <>{Array.from({ length: 8 }, (_, i) => <Choice key={i} value={i in answers ? answers[i] ? 'yes' : 'no' : 'off'} options={[{ value: 'off', label: String.fromCharCode(65 + i) }, { value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }]} onChange={value => setAnswers(old => { const next = { ...old }; if (value === 'off') delete next[i]; else if (i in next || Object.keys(next).length < 3) next[i] = value === 'yes'; return next; })} />)}<Choice value={mode} onChange={setMode} options={[{ value: 'all', label: 'All (AND)' }, { value: 'any', label: 'At least one (OR)' }]} /></>}
      <Field label={action === 'withdraw' ? 'Test AUSD amount' : 'Shares / receipts'} value={quantity} onChange={setQuantity} numeric />
      {action === 'withdraw' && <><Field label="Recipient wallet on Monad testnet" value={recipient} onChange={setRecipient} /><Copy small>Only available AUSD can be withdrawn. Open positions and order reserves are separate.</Copy></>}
      <Button title={reviewed.busy ? 'Checking...' : 'Review action'} disabled={!owner || reviewed.busy || operation.busy || !!operation.pending} onPress={() => void review()} /><Notice>{reviewed.error}</Notice>
    </Card>
    {plan && <Card><Heading>{plan.kind === 'approve' ? 'Approve AUSD' : `Confirm ${plan.kind}`}</Heading>{!['withdraw', 'wrap', 'unwrap'].includes(plan.kind) && <Copy>{describeClaim(plan.scope, plan.mask)}</Copy>}
      <Copy>{amount(plan.kind === 'approve' ? plan.approval : plan.quantity)} {plan.kind === 'withdraw' || plan.kind === 'approve' ? 'test AUSD' : 'shares'}</Copy>
      {plan.limit && <Copy>{plan.kind === 'sell' ? 'Minimum received' : 'Maximum spend'}: {amount(plan.limit)} test AUSD</Copy>}{plan.recipient && <Copy>Recipient: {plan.recipient}</Copy>}{plan.payout && <Copy>Payout: {amount(plan.payout)} test AUSD</Copy>}
      <Copy small>Maximum fee: {formatUnits(BigInt(plan.gasBudget), 18)} test MON</Copy><Button title={clock / 1000 >= plan.quoteExpiry ? 'Review expired' : 'Confirm in wallet'} disabled={operation.busy || !!operation.pending || clock / 1000 >= plan.quoteExpiry} onPress={() => void operations.legacy(plan, reviewed.value!.snapshot, kind, market, () => reviewed.isCurrent(reviewed.value!))} />
    </Card>}
    <Button secondary title="Load this pool's portfolio and history" disabled={!owner || portfolio.busy} onPress={() => readPortfolio()} /><Notice>{portfolio.error}</Notice>
    {portfolio.value && <><Copy small>Block {portfolio.value.snapshot.block_number}. {portfolio.value.index.complete ? 'Indexed to this checkpoint.' : 'History scan incomplete. Refresh to continue.'}</Copy>
      {portfolio.value.positions?.map(p => <Card key={`${p.scope}:${p.mask}`}><Heading>{describeClaim(p.scope, p.mask)}</Heading><Copy small>{describeClaimAnswers(p.scope, p.mask)}</Copy><Copy>{amount(p.quantity_atoms)} shares · {p.redeemable_atoms === null ? 'Awaiting settlement' : `${amount(p.redeemable_atoms)} test AUSD redeemable`}</Copy></Card>)}
      {portfolio.value.history?.map(e => <Card key={e.transaction_hash + e.log_index}><Copy>{e.kind} · {describeClaim(e.scope, Number(e.mask))}</Copy><Copy>{amount(e.quantity_atoms)} shares</Copy><External title="View transaction" url={`https://testnet.monadscan.com/tx/${e.transaction_hash}`} /></Card>)}
      {page > 0 && <Button secondary title="Previous page" onPress={() => readPortfolio(page - 1)} />}
      {(page + 1) * (portfolio.value.page_size ?? 20) < Math.max(portfolio.value.position_count ?? 0, portfolio.value.history_count ?? 0) && <Button secondary title="Next page" onPress={() => readPortfolio(page + 1)} />}
    </>}
  </>;
}
