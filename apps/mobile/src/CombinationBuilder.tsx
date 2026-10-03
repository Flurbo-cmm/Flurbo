import { useEffect, useState, useSyncExternalStore } from 'react';
import { View } from 'react-native';
import { formatUnits } from 'viem';
import { pilotRequest, validatePilotReview, type PilotState, type PilotReview } from '../../web/src/pilot';
import { amount, describeClaimAnswers } from '../../web/src/portfolio';
import type { MarketGroup } from '../../web/src/market-directory';
import { auth } from './runtime';
import { externalWallet, type WalletKind } from './wallet';
import { transactions } from './transactions';
import { makeClaim, quantityAtoms, type CombinationRule } from './market-model';
import { useRequest } from './hooks';
import { semanticCollision, semanticReady, type SemanticConsent } from './semantic';
import { semanticAcknowledgment } from '../../web/src/pilot';
import { Button, Card, Choice, Copy, Field, Heading, Notice, Title, s } from './ui';

export function CombinationBuilder({
  group,
  initialEvent,
  kind,
  onBack,
  onPortfolio,
}: {
  group: MarketGroup;
  initialEvent?: number;
  kind: WalletKind;
  onBack: () => void;
  onPortfolio: () => void;
}) {
  const login = useSyncExternalStore(auth.subscribe, auth.getSnapshot);
  const wallet = useSyncExternalStore(externalWallet.subscribe, externalWallet.getSnapshot);
  const tx = useSyncExternalStore(transactions.subscribe, transactions.getSnapshot);
  const owner = wallet.address;

  const [state, setState] = useState<PilotState | null>(null);
  const [answers, setAnswers] = useState<Record<number, boolean>>(() =>
    initialEvent !== undefined ? { [initialEvent]: true } : {}
  );
  const [rule, setRule] = useState<CombinationRule>('all');
  const [side, setSide] = useState<'buy' | 'sell' | 'redeem'>('buy');
  const [quantity, setQuantity] = useState('1');
  const [error, setError] = useState('');
  const [clock, setClock] = useState(Date.now());
  const [consent, setConsent] = useState<SemanticConsent>({ review: null, phrase: '' });

  const quote = useRequest<PilotReview>();

  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const c = new AbortController();
    void pilotRequest<PilotState>('status', undefined, group.namespace, c.signal).then(s => setState(s)).catch(() => {});
    return () => c.abort();
  }, [group.namespace]);

  const events = state?.manifest.publication.draft.events ?? [];
  const selectedCount = Object.keys(answers).length;

  function toggleEvent(index: number, yes: boolean) {
    if (tx.busy) return;
    if (!(index in answers) && selectedCount >= 3) {
      setError('A single combination can include up to three questions.');
      return;
    }
    setError('');
    setAnswers(prev => ({ ...prev, [index]: yes }));
  }

  function removeEvent(index: number) {
    setError('');
    setAnswers(prev => {
      const next = { ...prev };
      delete next[index];
      return next;
    });
  }

  // Quote calculation
  useEffect(() => {
    quote.cancel(true);
    setError('');
    if (!owner || selectedCount < 2 || tx.pending || !state) return;

    const timer = setTimeout(() => {
      void quote.run(async signal => {
        const { scope, mask } = makeClaim(answers, rule);
        const units = quantityAtoms(quantity);
        const input = { owner, action: side, scope, mask, quantity: units, slippageBps: 50 };
        const result = await pilotRequest<PilotReview>('prepare', input, group.namespace, signal);
        validatePilotReview(result);
        if (
          result.requested.owner.toLowerCase() !== owner.toLowerCase() ||
          result.requested.scope !== scope ||
          result.requested.mask !== mask ||
          result.requested.quantity !== units ||
          result.requested.action !== side ||
          result.manifest.pool !== state.manifest.pool
        ) {
          throw new Error('Price differs from selection. Refresh before trading.');
        }
        return result;
      }, true);
    }, 400);

    return () => {
      clearTimeout(timer);
      quote.cancel();
    };
  }, [answers, rule, side, quantity, owner, group.namespace, state?.manifest.pool, tx.pending, selectedCount]);

  let claimSummary = '';
  try {
    if (selectedCount > 0) {
      const c = makeClaim(answers, rule);
      claimSummary = describeClaimAnswers(c.scope, Number(c.mask));
    }
  } catch {
    // Incomplete
  }

  async function confirmTrade() {
    if (!quote.value || quote.busy) return;
    const reviewed = quote.value;
    try {
      await transactions.submit(reviewed, group.namespace, kind, () => quote.isCurrent(reviewed), consent);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Transaction could not be submitted.');
    }
  }

  return (
    <>
      <Button secondary title="Back" onPress={onBack} />

      <Card>
        <Copy small>{group.label.toUpperCase()} · COMBINATION BUILDER</Copy>
        <Heading>Build a combination prediction</Heading>
        <Copy>
          Select 2 or 3 questions from this pool. One shared LMSR pool prices all combinations with mathematical consistency.
        </Copy>
      </Card>

      {/* Selectable Questions */}
      <Card>
        <Heading>Select questions ({selectedCount} of 3 chosen)</Heading>
        {events.map((event, i) => (
          <View key={event.id} style={{ gap: 8, paddingVertical: 6, borderBottomWidth: 1, borderColor: '#ecebe2' }}>
            <Copy>{event.question}</Copy>
            <View style={s.row}>
              <Button
                secondary={answers[i] !== true}
                title={answers[i] === true ? 'Yes (Selected)' : 'Pick Yes'}
                onPress={() => toggleEvent(i, true)}
              />
              <Button
                secondary={answers[i] !== false}
                title={answers[i] === false ? 'No (Selected)' : 'Pick No'}
                onPress={() => toggleEvent(i, false)}
              />
              {i in answers && <Button secondary title="Remove" onPress={() => removeEvent(i)} />}
            </View>
          </View>
        ))}
      </Card>

      {/* Combination Config */}
      {selectedCount >= 2 ? (
        <Card>
          <Heading>Combination rule</Heading>
          <Copy small>{claimSummary}</Copy>

          <Choice
            value={rule}
            options={[
              { value: 'all', label: 'All happen (AND)' },
              { value: 'any', label: 'At least one (OR)' },
              { value: 'exact1', label: 'Exactly one happens' },
              { value: 'atLeast2', label: 'At least two happen' },
            ]}
            onChange={setRule}
          />

          <Choice
            value={side}
            options={[
              { value: 'buy', label: 'Buy' },
              { value: 'sell', label: 'Sell' },
              { value: 'redeem', label: 'Redeem' },
            ]}
            onChange={setSide}
          />

          <Field label="Quantity of shares" value={quantity} onChange={setQuantity} numeric />

          <View style={s.row}>
            {['1', '5', '10', '25', '50'].map(q => (
              <Button key={q} secondary={quantity !== q} title={`${q} shares`} onPress={() => setQuantity(q)} />
            ))}
          </View>

          {!owner ? (
            <>
              <Copy small>Connect MetaMask to trade this combination.</Copy>
              <Button
                title={wallet.busy ? 'Connecting MetaMask...' : 'Connect MetaMask'}
                disabled={wallet.busy}
                onPress={() => void externalWallet.connect()}
              />
            </>
          ) : (
            <Copy small>Trading with wallet: {owner}</Copy>
          )}

          <Notice>{wallet.error || error || quote.error}</Notice>

          {quote.busy && <Copy>Calculating executable price for combination...</Copy>}

          {quote.value && (
            <>
              <Heading>{quote.value.title}</Heading>
              <Copy>
                {quote.value.action === 'approve'
                  ? 'Allowance required: '
                  : side === 'sell'
                  ? 'Minimum proceeds: '
                  : 'Maximum cost: '}
                {amount(side === 'sell' ? quote.value.minimumReceivedAtoms : quote.value.amountAtoms)} test AUSD
              </Copy>
              <Copy small>
                Max network fee: {formatUnits(BigInt(quote.value.maximumFeeWei), 18)} test MON · 0.5% slippage
              </Copy>
              <Copy small>{quote.value.notice}</Copy>

              {semanticCollision(quote.value) && (
                <Card>
                  <Heading>Conflicting combination</Heading>
                  <Copy>
                    Under published rules, these outcomes cannot win simultaneously. To proceed manually, type the
                    acknowledgment phrase.
                  </Copy>
                  <Field
                    label={semanticAcknowledgment}
                    value={consent.review === quote.value ? consent.phrase : ''}
                    onChange={phrase => setConsent({ review: quote.value, phrase })}
                  />
                </Card>
              )}

              {clock / 1000 >= quote.value.expiresAt ? (
                <Notice>Price quote expired. Adjust shares or refresh to update.</Notice>
              ) : (
                <Button
                  title={
                    tx.busy
                      ? 'Checking transaction...'
                      : quote.value.action === 'approve'
                      ? 'Approve AUSD in wallet'
                      : `Confirm ${side} combination`
                  }
                  disabled={quote.busy || tx.busy || !!tx.pending || !semanticReady(quote.value, consent)}
                  onPress={() => void confirmTrade()}
                />
              )}
            </>
          )}
        </Card>
      ) : (
        <Card>
          <Heading>Pick at least 2 questions</Heading>
          <Copy>Choose Yes or No for at least 2 questions above to price a combined prediction bundle.</Copy>
        </Card>
      )}

      <Button secondary title="View portfolio" onPress={onPortfolio} />
    </>
  );
}
