import { useEffect, useState, useSyncExternalStore } from 'react';
import * as learning from '../../web/src/learning/execution';
import { amount } from '../../web/src/portfolio';
import { useRequest } from './hooks';
import { api } from './api';
import { externalWallet } from './wallet';
import { operations } from './operations';
import { Button, Card, Copy, Heading, Notice, Title } from './ui';

type LearningPool = { schema: string; pool: string; updater: string; block: string; updates: string; collateralAtoms: string; reserveAtoms: string; covered: boolean; open: boolean; modelReady: boolean; operator: boolean };
export function Learning() {
  const data = useRequest<LearningPool>(), proposal = useRequest<learning.Review>(), comparison = useRequest<any>();
  const operation = useSyncExternalStore(operations.subscribe, operations.getSnapshot), wallet = useSyncExternalStore(externalWallet.subscribe, externalWallet.getSnapshot);
  const [clock, setClock] = useState(Date.now());
  useEffect(() => { void data.run(signal => api('/api/learning/pool', undefined, signal)); const timer = setInterval(() => setClock(Date.now()), 1000); return () => clearInterval(timer); }, []);
  return <><Title>Learning lab.</Title><Copy>A separate testnet pool for funded price updates. A synthetic Rust fixture learns from one A AND B observation. There is no live observation feed or automatic repricing.</Copy>
    <Button secondary title="Refresh pool status" onPress={() => void data.run(signal => api('/api/learning/pool', undefined, signal))} /><Notice>{data.error}</Notice>
    {data.value && <Card><Copy>{data.value.open ? 'Open' : 'Closed'} · {data.value.covered ? 'Covered' : 'Coverage unavailable'}</Copy><Copy>{amount(data.value.collateralAtoms)} test AUSD in pool</Copy><Copy>Reserve: {amount(data.value.reserveAtoms)} test AUSD</Copy><Copy>Updates: {data.value.updates}</Copy><Copy small>{data.value.pool} · Block {data.value.block}</Copy></Card>}
    <Button title="Prepare synthetic proposal" disabled={!data.value?.operator || !data.value?.modelReady || proposal.busy || operation.busy || !!operation.pending} onPress={() => void proposal.run(async signal => { const value = await api<learning.Review>('/api/learning/proposal', {}, signal); learning.validateReview(value); return value; }, true)} /><Notice>{proposal.error}</Notice>
    {proposal.value && <Card><Heading>Review the proposed update</Heading><Copy>Maximum added funding: {amount(proposal.value.fundingAtoms)} test AUSD</Copy><Copy>One A AND B share: {amount(proposal.value.quoteBeforeAtoms)} to {amount(proposal.value.quoteAfterAtoms)} test AUSD</Copy><Copy small>These are quantity quotes, not probabilities. {proposal.value.notice}</Copy><Copy small>Expected revision {proposal.value.snapshot.revision}. Only the configured deployer can sign.</Copy><Copy small>Connected MetaMask: {wallet.address ?? 'Connect in Wallet'}</Copy><Button title={clock / 1000 >= proposal.value.expiresAt ? 'Proposal expired' : 'Confirm proposal in MetaMask'} disabled={!wallet.address || clock / 1000 >= proposal.value.expiresAt || operation.busy || !!operation.pending} onPress={() => void operations.learning(proposal.value!, () => proposal.isCurrent(proposal.value!))} /></Card>}
    <Button secondary title="Load research comparison" disabled={comparison.busy} onPress={() => void comparison.run(async signal => {
      const value = await api<any>('/api/learning/comparison', undefined, signal);
      const scenarios = ['stationary', 'regime_change', 'noisy', 'poison_recovery', 'higher_order'];
      const models = ['pairwise_all', 'pairwise_singles', 'independent_all', 'uniform'];
      if (value.schema !== 'flurbo.learning-comparison.v1' || value.input !== 'synthetic' || value.changesExecutablePrices !== false || !Array.isArray(value.summaries) || value.summaries.length !== 20 || !Number.isFinite(Date.parse(value.generatedAt)) || scenarios.some(scenario => models.some(model => { const rows = value.summaries.filter((r: any) => r.scenario === scenario && r.model === model); return rows.length !== 1 || !Number.isFinite(rows[0].finalMse) || rows[0].finalMse < 0 || rows[0].finalMse > 1; }))) throw new Error('Research comparison could not be verified.');
      return value;
    }, true)} /><Notice>{comparison.error}</Notice>
    {comparison.value?.schema === 'flurbo.learning-comparison.v1' && <Card><Heading>Synthetic research</Heading><Copy small>This comparison does not change executable prices. It does not reproduce historical-data experiments or establish statistical loss guarantees.</Copy>{comparison.value.summaries?.map((row: any, i: number) => <Copy key={i}>{row.scenario} · {row.model}: MSE {Number(row.initialMse).toFixed(4)} to {Number(row.finalMse).toFixed(4)}</Copy>)}</Card>}
  </>;
}
