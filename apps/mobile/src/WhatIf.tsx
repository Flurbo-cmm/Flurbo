import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { pilotRequest, type PilotNamespace } from '../../web/src/pilot';
import type { MarketSnapshot } from '../../web/src/market-directory';
import { type Analysis, validateAnalysis } from './market-model';
import { useRequest } from './hooks';
import { Button, Card, Copy, Heading, Notice, Title, colors } from './ui';

export function WhatIf({ namespace }: { namespace: PilotNamespace }) {
  const markets = useRequest<MarketSnapshot>();
  const result = useRequest<Analysis>();
  const [a, setA] = useState(0);
  const [b, setB] = useState(1);
  const [clock, setClock] = useState(Date.now());

  useEffect(() => {
    void markets.run(signal => pilotRequest('markets', undefined, namespace, signal), true);
    result.cancel(true);
    return () => {
      markets.cancel();
      result.cancel();
    };
  }, [namespace]);

  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  function select(which: 'a' | 'b', value: number) {
    result.cancel(true);
    if (which === 'a') {
      setA(value);
      if (value === b) setB(a);
    } else {
      setB(value);
      if (value === a) setA(b);
    }
  }

  const events = markets.value?.manifest.publication.draft.events ?? [];
  const data = result.value;
  const fresh = data && clock / 1000 < data.expiresAt && clock / 1000 >= data.snapshot.timestamp - 15;
  const percent = (key: keyof Analysis['values']) =>
    data?.values[key] == null ? 'Unavailable' : `${(data.values[key]! / 10).toFixed(1)}${key === 'difference' ? ' pp' : '%'}`;

  return (
    <>
      <Title>What if?</Title>
      <Copy>Explore how the shared market prices the relationship between two answers.</Copy>
      <Notice>{markets.error}</Notice>
      {(['a', 'b'] as const).map(which => (
        <Card key={which}>
          <Heading>{which === 'a' ? 'Question to explore' : 'Suppose this question resolves'}</Heading>
          {events.map((e: MarketSnapshot['manifest']['publication']['draft']['events'][number], i: number) => (
            <Button
              key={e.id}
              secondary={(which === 'a' ? a : b) !== i}
              title={e.question}
              onPress={() => select(which, i)}
            />
          ))}
        </Card>
      ))}
      <Button
        title={result.busy ? 'Cancel comparison' : 'Compare these questions'}
        disabled={!markets.value}
        onPress={() =>
          result.busy
            ? result.cancel()
            : void result.run(
                async signal =>
                  validateAnalysis(
                    await pilotRequest<Analysis>('analytics', { a, b }, namespace, signal),
                    markets.value!.manifest,
                    a,
                    b
                  ),
                true
              )
        }
      />
      <Notice>{result.error}</Notice>
      {data && !fresh && (
        <Notice>This snapshot is over a minute old or its time could not be verified. Refresh to see current values.</Notice>
      )}
      {fresh && (
        <>
          <Heading>Chance of Yes: {events[a]?.question}</Heading>
          {(['a', 'givenYes', 'givenNo'] as const).map((key, i) => (
            <Card key={key}>
              <Copy>{['Without an assumption', 'If the second answer is Yes', 'If the second answer is No'][i]}</Copy>
              <Title>{percent(key)}</Title>
              {data.values[key] === null && (
                <Copy small>
                  {data.reasons[key] === 'rare_condition'
                    ? 'This condition is too rare to display reliably.'
                    : 'Precision is insufficient at this snapshot.'}
                </Copy>
              )}
            </Card>
          ))}
          <Copy small>
            {events[b]?.question} Market-implied Yes chance: {percent('b')}
          </Copy>
          <Card>
            <Heading>Both Yes, together</Heading>
            {(['joint', 'independent'] as const).map((key, i) => (
              <View key={key} style={{ gap: 10 }}>
                <Copy>
                  {i ? 'If independent' : 'Shared market'}: {percent(key)}
                </Copy>
                <View style={{ height: 9, backgroundColor: colors.line, borderRadius: 8 }}>
                  <View
                    style={{
                      height: 9,
                      borderRadius: 8,
                      backgroundColor: i ? '#879564' : colors.ink,
                      width: `${(data.values[key] ?? 0) / 10}%`,
                    }}
                  />
                </View>
              </View>
            ))}
            <Copy>Difference: {percent('difference')} (percentage points)</Copy>
          </Card>
          <Copy small>
            Block {data.snapshot.blockNumber} · {new Date(data.snapshot.timestamp * 1000).toLocaleString()}. All values
            use the same snapshot.{data.closed ? ' Trading is closed; these weights are not settled outcomes.' : ''}
          </Copy>
        </>
      )}
      <Card>
        <Heading>How to read this</Heading>
        <Copy>
          These are probabilities implied by the pool model. Buying a share has a different cost because your trade
          moves the price.
        </Copy>
        <Copy>
          The independence baseline multiplies the individual Yes probabilities. Conditioning assumes an answer is
          known. It does not show that one event causes another.
        </Copy>
        <Copy small>
          This is read-only exploration. It cannot create a conditional position or guarantee accurate outcomes. Practice
          outcomes are scripted.
        </Copy>
      </Card>
    </>
  );
}
