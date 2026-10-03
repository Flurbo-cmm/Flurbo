import { useEffect, useState, useSyncExternalStore } from 'react';
import { pilotRequest, validatePilotReview, type PilotInput, type PilotNamespace, type PilotReview, type PilotState } from '../../web/src/pilot';
import { amount } from '../../web/src/portfolio';
import { auth } from './runtime';
import { externalWallet, type WalletKind } from './wallet';
import { transactions } from './transactions';
import { useRequest } from './hooks';
import { Button, Card, Choice, Copy, External, Field, Heading, Notice, Title } from './ui';

export function Settlement({ namespace, kind }: { namespace: PilotNamespace; kind: WalletKind }) {
  const login = useSyncExternalStore(auth.subscribe, auth.getSnapshot), wallet = useSyncExternalStore(externalWallet.subscribe, externalWallet.getSnapshot), pending = useSyncExternalStore(transactions.subscribe, transactions.getSnapshot);
  const owner = wallet.address;
  const state = useRequest<PilotState>(), review = useRequest<PilotReview>(), evidence = useRequest<{ hash: string; uri: string }>();
  const [event, setEvent] = useState(0), [outcome, setOutcome] = useState('2'), [statement, setStatement] = useState(''), [source, setSource] = useState(''), [attachment, setAttachment] = useState(''), [error, setError] = useState('');
  const refresh = () => void state.run(signal => pilotRequest('status' + (owner ? '?wallet=' + owner : ''), undefined, namespace, signal), true);
  useEffect(() => { refresh(); return () => state.cancel(); }, [namespace, owner, pending.pending]);
  useEffect(() => { review.cancel(true); evidence.cancel(true); }, [event, outcome, statement, source, attachment, owner]);
  async function prepare(input: Omit<PilotInput, 'owner'>) {
    if (!owner) return;
    await review.run(async signal => {
      const result = await pilotRequest<PilotReview>('prepare', { ...input, owner }, namespace, signal);
      validatePilotReview(result);
      if (result.requested.owner.toLowerCase() !== owner.toLowerCase() || result.requested.action !== input.action || result.manifest.pool !== state.value?.manifest.pool) throw new Error('Review does not match this action.');
      for (const key of ['event', 'outcome', 'evidenceHash', 'evidenceURI'] as const) if (input[key] !== undefined && result.requested[key] !== input[key]) throw new Error('Review changed the selected evidence.');
      return result;
    }, true);
  }
  const current = state.value?.cases[event], events = state.value?.manifest.publication.draft.events ?? [];
  const disabled = !owner || review.busy || pending.busy || !!pending.pending;
  return <><Title>Resolution.</Title><Copy>Review the evidence, challenge an answer, or finalize a completed window. Each transaction needs your confirmation.</Copy><Button secondary title="Refresh settlement" onPress={refresh} /><Notice>{state.error}</Notice>
    {events.map((e, i) => <Button key={e.id} secondary={event !== i} title={e.question} onPress={() => setEvent(i)} />)}
    {current && <Card><Heading>{events[event]?.question}</Heading><Copy>{['Awaiting evidence', 'Challenge window', 'Under review', 'Final result'][current.phase]}</Copy><Copy>Proposed: {['Unset', 'No', 'Yes', 'Void'][current.proposal]} · Final: {['Unset', 'No', 'Yes', 'Void'][current.result]}</Copy>
      <Copy small>Assertion deadline: {new Date(Number(current.assertionDeadline) * 1000).toLocaleString()}</Copy>
      {Number(current.challengeUntil) > 0 && <Copy small>Challenge ends: {new Date(Number(current.challengeUntil) * 1000).toLocaleString()}</Copy>}
      {Number(current.voteUntil) > 0 && <Copy small>Voting ends: {new Date(Number(current.voteUntil) * 1000).toLocaleString()}</Copy>}
      <Copy>{events[event]?.yesRule}</Copy><Copy>{events[event]?.noRule}</Copy>
      {[current.evidenceHash, current.counterEvidenceHash].filter(h => !/^0x0{64}$/.test(h)).map(h => <External key={h} title="Read published evidence" url={`https://flurbo.singu.online/api/pilot/evidence/${h}`} />)}
    </Card>}
    <Card><Heading>Publish your evidence</Heading><Choice value={outcome} onChange={setOutcome} options={[{ value: '2', label: 'Yes' }, { value: '1', label: 'No' }, { value: '3', label: 'Void' }]} />
      <Field label="Your explanation" value={statement} onChange={setStatement} multiline /><Field label="Public source URL" value={source} onChange={setSource} /><Field label="Evidence excerpt" value={attachment} onChange={setAttachment} multiline />
      <Copy small>Publishing saves a public copy. Include public material only. A missing source response is not proof of No.</Copy>
      <Button title="Publish public evidence" disabled={disabled || evidence.busy || !statement.trim()} onPress={() => void evidence.run(signal => pilotRequest('evidence', { eventId: events[event]?.id, outcome: Number(outcome), statement, sourceURL: source, attachment }, namespace, signal), true)} /><Notice>{evidence.error}</Notice>
      {evidence.value && <><External title="Read your published evidence" url={evidence.value.uri} />{(['assertOutcome', 'dispute', 'vote'] as const).map(action => <Button key={action} title={{ assertOutcome: 'Review assertion', dispute: 'Review challenge', vote: 'Review vote' }[action]} disabled={disabled || (action === 'assertOutcome' ? current?.phase !== 0 : action === 'dispute' ? current?.phase !== 1 : current?.phase !== 2 || !state.value?.wallet?.reviewer || current.voted)} onPress={() => void prepare({ action, event, outcome: Number(outcome), evidenceHash: evidence.value!.hash, evidenceURI: evidence.value!.uri })} />)}</>}
    </Card>
    <Button secondary title="Review deadline finalization" disabled={disabled || !current || current.phase === 3} onPress={() => void prepare({ action: 'finalize', event })} />
    <Button secondary title="Review settlement delivery" disabled={disabled || !state.value || state.value.delivered || !state.value.cases.every(c => c.phase === 3)} onPress={() => void prepare({ action: 'deliver' })} />
    <Button secondary title="Withdraw bond credit" disabled={disabled || !state.value?.wallet || state.value.wallet.credits === '0'} onPress={() => void prepare({ action: 'withdrawBond' })} />
    <Notice>{review.error || error}</Notice>
    {review.value && <Card><Heading>{review.value.title}</Heading><Copy>{amount(review.value.amountAtoms)} test AUSD</Copy><Copy small>{review.value.notice}</Copy><Button title={review.value.action === 'approve' ? 'Confirm allowance in wallet' : 'Confirm action in wallet'} disabled={disabled} onPress={() => { const saved = review.value!; void transactions.submit(saved, namespace, kind, () => review.isCurrent(saved)).catch(e => setError(e.message)); }} /></Card>}
    <Copy small>A wrong uncontested assertion can finalize. The test reviewers are controlled by one operator. Monitoring does not verify truth or reverse settlement.</Copy>
  </>;
}
