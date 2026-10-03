import { useEffect, useState } from 'react';
import { pilotRequest, type PilotNamespace, type PilotState } from '../../web/src/pilot';
import { amount, describeClaimAnswers } from '../../web/src/portfolio';
import { portfolioClaims, rememberedClaims, type ClaimHint } from '../../web/src/pilot-claims';
import { useRequest } from './hooks';
import { Button, Card, Copy, External, Field, Heading, Notice, Title } from './ui';

type Account = Pick<PilotState, 'manifest' | 'snapshot'> & { wallet: { address: string; cash: string }; claimScopes?: number[] };
type Entry = { hash: string; block: number; index: number; name: string; args: Record<string, string | number | boolean> };
type Index = { complete: boolean; through: number; target: number; logs: Entry[] };
type Holdings = { snapshot: PilotState['snapshot']; rows: (ClaimHint & { quantity: string; payoutAtoms: string | null })[] };
export function Ledger({ namespace, address, history, linked=false }: { namespace: PilotNamespace; address: string; history: boolean; linked?:boolean }) {
  const [wallet, setWallet] = useState(address), [owner, setOwner] = useState(address), [page, setPage] = useState(0), [claims, setClaims] = useState<ClaimHint[]>([]), [error, setError] = useState('');
  const account = useRequest<Account>(), index = useRequest<Index>(), holdings = useRequest<Holdings>();
  useEffect(() => { setOwner(address); setWallet(address); }, [address]);
  useEffect(() => {
    account.cancel(true); index.cancel(true); holdings.cancel(true); setPage(0); setClaims([]);
    refresh();
    return () => { account.cancel(); index.cancel(); holdings.cancel(); };
  }, [namespace, owner]);
  useEffect(() => {
    if (!account.value) return;
    const state = account.value;
    const indexed = (index.value?.logs ?? []).filter(e => String(e.args.owner ?? e.args.trader ?? '').toLowerCase() === owner.toLowerCase() && e.args.scope !== undefined && e.args.mask !== undefined).map(e => ({ scope: Number(e.args.scope), mask: String(e.args.mask) }));
    const all = portfolioClaims(state.manifest.publication.draft.events.length, state.claimScopes ?? [], rememberedClaims(namespace, state.manifest.pool, owner, state.manifest.publication.draft.events.length), indexed);
    setClaims(all);
    void holdings.run(signal => pilotRequest('positions', { owner, claims: all.slice(page * 30, page * 30 + 30) }, namespace, signal), true);
  }, [account.value, index.value, page]);
  function refresh() {
    if (!/^0x[0-9a-f]{40}$/i.test(owner)) return;
    void account.run(signal => pilotRequest('account?wallet=' + owner, undefined, namespace, signal));
    // A log index failure never blocks direct reads of shares.
    void index.run(signal => pilotRequest('history', {}, namespace, signal));
  }
  function change(next: string) {
    if (!/^0x[0-9a-f]{40}$/i.test(next)) { setError('Enter a public wallet address.'); return; }
    setError(''); setWallet(next); setOwner(next.toLowerCase());
    if (next.toLowerCase() === owner.toLowerCase()) refresh();
  }
  const events = account.value?.manifest.publication.draft.events;
  const names = (scope: number) => events?.filter((_, i) => scope & (1 << i)).map(e => e.question).join(' + ') ?? 'Prediction';
  const activity = (index.value?.logs ?? []).filter(e => ['Asserted', 'Disputed', 'Voted', 'Finalized', 'Delivered'].includes(e.name) || Object.values(e.args).some(v => typeof v === 'string' && v.toLowerCase() === owner.toLowerCase())).slice().reverse();
  const [historyPage, setHistoryPage] = useState(0);
  useEffect(() => setHistoryPage(0), [owner, namespace]);
  return <>{!linked&&<Title>Your {history ? 'history' : 'portfolio'}.</Title>}
    {!linked&&<Card><Field label="Wallet to view" value={wallet} onChange={setWallet} /><Button title="View wallet" onPress={() => change(wallet)} /><Notice>{error}</Notice><Copy small>Enter your MetaMask address, or an address holding earlier positions. You can switch while data loads.</Copy></Card>}
    <Copy small>Showing {owner}</Copy>
    <Button secondary title={account.busy || index.busy || holdings.busy ? 'Stop loading' : 'Refresh'} onPress={() => { if (account.busy || index.busy || holdings.busy) { account.cancel(); index.cancel(); holdings.cancel(); } else refresh(); }} />
    <Notice>{account.error}</Notice>{account.value && <Copy>{amount(account.value.wallet.cash)} test AUSD · Block {account.value.snapshot.blockNumber}</Copy>}
    {history && <><Heading>Your activity</Heading><Notice>{index.error}</Notice>{index.busy && <Copy small>Checking recent activity...</Copy>}
      {activity.slice(historyPage * 20, historyPage * 20 + 20).map(e => <Card key={e.hash + e.index}><Copy small>{e.name === 'Traded' ? e.args.isBuy ? 'Bought' : 'Sold' : e.name}</Copy>
        {e.args.scope !== undefined && <><Heading>{names(Number(e.args.scope))}</Heading><Copy small>{describeClaimAnswers(Number(e.args.scope), Number(e.args.mask))}</Copy></>}
        {e.args.quantity !== undefined && <Copy>{amount(String(e.args.quantity))} shares</Copy>}
        {e.args.collateralAmount !== undefined && <Copy>{amount(String(e.args.collateralAmount))} test AUSD</Copy>}
        <External title="View transaction" url={`https://testnet.monadscan.com/tx/${e.hash}`} /><Copy small>Block {e.block}</Copy></Card>)}
      {index.value && !activity.length && <Copy>{index.value.complete ? 'No activity found for this wallet.' : 'No activity found yet. More history is available.'}</Copy>}
      {historyPage > 0 && <Button secondary title="Previous activity" onPress={() => setHistoryPage(historyPage - 1)} />}
      {(historyPage + 1) * 20 < activity.length && <Button secondary title="Next activity" onPress={() => setHistoryPage(historyPage + 1)} />}
    </>}
    {index.value && !index.value.complete && <Card><Copy small>History checked through block {index.value.through}. More history is available. Your shares are checked separately.</Copy><Button secondary title={index.busy ? 'Stop history search' : 'Load more history'} onPress={() => index.busy ? index.cancel() : void index.run(signal => pilotRequest('history', {}, namespace, signal))} /></Card>}
    <Heading>Your shares</Heading><Notice>{holdings.error}</Notice>
    {holdings.busy && <Copy small>Reading shares from the pool...</Copy>}
    {holdings.value?.rows.filter(r => BigInt(r.quantity) > 0n).map(r => <Card key={`${r.scope}:${r.mask}`}><Heading>{names(r.scope)}</Heading><Copy small>{describeClaimAnswers(r.scope, Number(r.mask))}</Copy><Copy>{amount(r.quantity)} shares</Copy><Copy>{r.payoutAtoms === null ? 'Awaiting settlement' : `${amount(r.payoutAtoms)} test AUSD redeemable`}</Copy></Card>)}
    {holdings.value && !holdings.value.rows.some(r => BigInt(r.quantity) > 0n) && <Copy>No shares in the predictions checked on this page.</Copy>}
    {!holdings.value && !holdings.busy && <Copy>Shares are unavailable. This does not mean you have no positions.</Copy>}
    {holdings.value && <Copy small>Shares checked at block {holdings.value.snapshot.blockNumber}. Combined predictions are included. Other claim types may appear as history loads.</Copy>}
    {page > 0 && <Button secondary title="Previous shares" onPress={() => setPage(page - 1)} />}
    {(page + 1) * 30 < claims.length && <Button secondary title="Next shares" onPress={() => setPage(page + 1)} />}
  </>;
}
