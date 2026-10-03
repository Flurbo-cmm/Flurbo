import { useEffect, useState, useSyncExternalStore } from 'react';
import { View } from 'react-native';
import { formatUnits } from 'viem';
import { pilotRequest, validatePilotReview, type PilotState, type PilotReview } from '../../web/src/pilot';
import { amount } from '../../web/src/portfolio';
import type { MarketGroup } from '../../web/src/market-directory';
import { auth } from './runtime';
import { externalWallet, type WalletKind } from './wallet';
import { transactions } from './transactions';
import { quantityAtoms } from './market-model';
import { useRequest } from './hooks';
import { semanticCollision, semanticReady, type SemanticConsent } from './semantic';
import { semanticAcknowledgment } from '../../web/src/pilot';
import { Button, Card, Choice, Copy, Field, Heading, Notice, Title, s } from './ui';

export function MarketDetail({
  group,
  eventIndex,
  kind,
  onCombine,
  onWhatIf,
  onBack,
  onPortfolio,
}: {
  group: MarketGroup;
  eventIndex: number;
  kind: WalletKind;
  onCombine: () => void;
  onWhatIf: () => void;
  onBack: () => void;
  onPortfolio: () => void;
}) {
  const login = useSyncExternalStore(auth.subscribe, auth.getSnapshot);
  const wallet = useSyncExternalStore(externalWallet.subscribe, externalWallet.getSnapshot);
  const tx = useSyncExternalStore(transactions.subscribe, transactions.getSnapshot);
  const owner = wallet.address;

  const [state, setState] = useState<PilotState | null>(null);
  const [quotes, setQuotes] = useState<{ yes: string | null; no: string | null } | null>(null);
  const [positions, setPositions] = useState<{ yes: string; no: string; payout: string | null } | null>(null);

  const [answer, setAnswer] = useState<boolean>(true); // true = Yes, false = No
  const [side, setSide] = useState<'buy' | 'sell' | 'redeem'>('buy');
  const [quantity, setQuantity] = useState('1');
  const [error, setError] = useState('');
  const [rulesExpanded, setRulesExpanded] = useState(false);
  const [clock, setClock] = useState(Date.now());
  const [consent, setConsent] = useState<SemanticConsent>({ review: null, phrase: '' });

  const quote = useRequest<PilotReview>();

  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  async function loadState(signal?: AbortSignal) {
    try {
      const s = await pilotRequest<PilotState>('status', undefined, group.namespace, signal);
      setState(s);
    } catch {
      // Keep earlier state
    }
  }

  async function loadQuotes(signal?: AbortSignal) {
    try {
      const v = await pilotRequest<{ prices: { event: number; yes: string | null; no: string | null }[] }>(
        'markets',
        undefined,
        group.namespace,
        signal
      );
      setQuotes(v.prices.find(p => p.event === eventIndex) || null);
    } catch {
      // Ignore
    }
  }

  async function loadPositions(signal?: AbortSignal) {
    if (!owner) {
      setPositions(null);
      return;
    }
    try {
      const scope = 1 << eventIndex;
      const res = await pilotRequest<{ rows: { mask: string; quantity: string; payoutAtoms: string | null }[] }>(
        'positions',
        { owner, claims: [{ scope, mask: '2' }, { scope, mask: '1' }] },
        group.namespace,
        signal
      );
      const yesRow = res.rows.find(r => r.mask === '2');
      const noRow = res.rows.find(r => r.mask === '1');
      setPositions({
        yes: yesRow?.quantity ?? '0',
        no: noRow?.quantity ?? '0',
        payout: yesRow?.payoutAtoms ?? noRow?.payoutAtoms ?? null,
      });
    } catch {
      // Keep previous
    }
  }

  useEffect(() => {
    const c = new AbortController();
    void loadState(c.signal);
    void loadQuotes(c.signal);
    void loadPositions(c.signal);
    return () => c.abort();
  }, [group.namespace, eventIndex, owner]);

  // Quote calculation
  useEffect(() => {
    quote.cancel(true);
    setError('');
    if (!owner || tx.pending || !state) return;

    const timer = setTimeout(() => {
      void quote.run(async signal => {
        const scope = 1 << eventIndex;
        const mask = answer ? '2' : '1';
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
    }, 350);

    return () => {
      clearTimeout(timer);
      quote.cancel();
    };
  }, [answer, side, quantity, owner, group.namespace, eventIndex, state?.manifest.pool, tx.pending]);

  const event = state?.manifest.publication.draft.events[eventIndex];
  const closesAt = state ? Number(state.manifest.publication.draft.closesAt) : group.closesAt;
  const isOpen = state ? clock / 1000 < closesAt && !state.delivered && !state.resolved : clock / 1000 < group.closesAt;

  async function confirmTrade() {
    if (!quote.value || quote.busy) return;
    const reviewed = quote.value;
    try {
      await transactions.submit(reviewed, group.namespace, kind, () => quote.isCurrent(reviewed), consent);
      void loadPositions();
      void loadQuotes();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Transaction could not be submitted.');
    }
  }

  return (
    <>
      <Button secondary title="Back to markets" onPress={onBack} />

      <Card>
        <Copy small>
          {group.label.toUpperCase()} · {isOpen ? 'TRADING OPEN' : 'TRADING CLOSED'}
        </Copy>
        <Heading>{event?.question ?? 'Market details'}</Heading>
        <Copy small>Closes {new Date(closesAt * 1000).toLocaleString()}</Copy>
      </Card>

      {/* Holdings Card */}
      {owner && positions && (BigInt(positions.yes) > 0n || BigInt(positions.no) > 0n) && (
        <Card>
          <Heading>Your shares in this question</Heading>
          <Copy>
            Yes: {amount(positions.yes)} shares · No: {amount(positions.no)} shares
          </Copy>
          {positions.payout !== null && (
            <Copy small>Estimated payout: {amount(positions.payout)} test AUSD</Copy>
          )}
          <Button secondary title="View all portfolio positions" onPress={onPortfolio} />
        </Card>
      )}

      {/* Trade Order Ticket */}
      <Card>
        <Heading>Trade this question</Heading>
        <Copy small>Select your answer and quantity to see live LMSR pricing.</Copy>

        <Choice
          value={answer ? 'yes' : 'no'}
          options={[
            { value: 'yes', label: `Yes ${quotes?.yes ? '· ' + amount(quotes.yes) + ' AUSD' : ''}` },
            { value: 'no', label: `No ${quotes?.no ? '· ' + amount(quotes.no) + ' AUSD' : ''}` },
          ]}
          onChange={val => setAnswer(val === 'yes')}
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

        {/* Quick Stepper Row */}
        <View style={s.row}>
          {['1', '5', '10', '25', '50'].map(q => (
            <Button key={q} secondary={quantity !== q} title={`${q} shares`} onPress={() => setQuantity(q)} />
          ))}
        </View>

        {!owner ? (
          <>
            <Copy small>Connect MetaMask to trade this prediction.</Copy>
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

        {quote.busy && <Copy>Calculating executable price...</Copy>}

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
              Max gas fee: {formatUnits(BigInt(quote.value.maximumFeeWei), 18)} test MON · 0.5% slippage
            </Copy>
            <Copy small>{quote.value.notice}</Copy>

            {semanticCollision(quote.value) && (
              <Card>
                <Heading>Conflicting outcomes</Heading>
                <Copy>
                  Under the rules, this position cannot win. Automated trade is blocked. To proceed manually, type the
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
              <Notice>Quote expired. Adjust quantity or refresh to see a current price.</Notice>
            ) : (
              <Button
                title={
                  tx.busy
                    ? 'Checking transaction...'
                    : quote.value.action === 'approve'
                    ? 'Approve AUSD in wallet'
                    : `Confirm ${side} in wallet`
                }
                disabled={quote.busy || tx.busy || !!tx.pending || !semanticReady(quote.value, consent)}
                onPress={() => void confirmTrade()}
              />
            )}
          </>
        )}
      </Card>

      {/* Combinations & What If Links */}
      <Card>
        <Heading>Combine with other questions</Heading>
        <Copy>
          This question shares an LMSR pool with other questions in {group.label}. You can bundle answers into AND, OR,
          or conditional predictions.
        </Copy>
        <Button secondary title="Open combination builder" onPress={onCombine} />
        <Button secondary title="Explore correlation (What if)" onPress={onWhatIf} />
      </Card>

      {/* Rules Disclosure */}
      <Button
        secondary
        title={rulesExpanded ? 'Hide settlement rules' : 'Read settlement rules & source'}
        onPress={() => setRulesExpanded(!rulesExpanded)}
      />

      {rulesExpanded && event && (
        <Card>
          <Heading>Settlement rules</Heading>
          <Copy small>YES RULE</Copy>
          <Copy>{event.yesRule}</Copy>
          <Copy small>NO RULE</Copy>
          <Copy>{event.noRule}</Copy>
          <Copy small>OBSERVATION ENDS</Copy>
          <Copy>{new Date(Number(event.observationEndsAt) * 1000).toLocaleString()}</Copy>
        </Card>
      )}
    </>
  );
}
