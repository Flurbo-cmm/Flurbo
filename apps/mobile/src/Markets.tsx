import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { formatUnits } from 'viem';
import { pilotRequest, type PilotState } from '../../web/src/pilot';
import { loadMarketDirectory, marketStatus, type MarketGroup, type MarketSnapshot } from '../../web/src/market-directory';
import { amount } from '../../web/src/portfolio';
import { useRequest } from './hooks';
import { Button, Card, Choice, Copy, Field, Heading, Notice, Title, s } from './ui';

export type DirectoryRow = {
  group: MarketGroup;
  event: MarketSnapshot['manifest']['publication']['draft']['events'][number];
  index: number;
  value: MarketSnapshot;
};

export function Markets({
  onSelectMarket,
  onFaucet,
}: {
  onSelectMarket: (group: MarketGroup, eventIndex: number) => void;
  onFaucet: () => void;
}) {
  const directory = useRequest<MarketGroup[]>();
  const [data, setData] = useState<Record<string, MarketSnapshot>>({});
  const [loadingPrices, setLoadingPrices] = useState(false);
  const [failed, setFailed] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'All' | 'Open' | 'Closed' | 'Settled'>('Open');
  const [sort, setSort] = useState<'closing' | 'name'>('closing');
  const [now, setNow] = useState(Date.now());
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // 1. Load directory of all active pools
  useEffect(() => {
    void directory.run(signal => loadMarketDirectory(signal), true);
  }, [revision]);

  // 2. Fetch market snapshots across all pools
  useEffect(() => {
    const groups = directory.value;
    if (!groups || !groups.length) return;

    const c = new AbortController();
    const queue = [...groups];
    setLoadingPrices(true);
    setFailed([]);

    void Promise.all(
      Array.from({ length: Math.min(2, queue.length) }, async () => {
        while (queue.length && !c.signal.aborted) {
          const group = queue.shift()!;
          try {
            const value = await pilotRequest<MarketSnapshot>('markets', undefined, group.namespace, c.signal);
            if (!c.signal.aborted) {
              setData(prev => ({ ...prev, [group.namespace]: value }));
            }
          } catch {
            if (!c.signal.aborted) {
              setFailed(prev => [...prev, group.namespace]);
            }
          }
        }
      })
    ).finally(() => {
      if (!c.signal.aborted) setLoadingPrices(false);
    });

    return () => c.abort();
  }, [directory.value, revision]);

  const groups = directory.value || [];
  const allRows: DirectoryRow[] = groups.flatMap(group =>
    data[group.namespace]
      ? data[group.namespace].manifest.publication.draft.events.map((event, index) => ({
          group,
          event,
          index,
          value: data[group.namespace],
        }))
      : []
  );

  const filteredRows = allRows
    .filter(r => {
      const status = marketStatus(r.value, now / 1000);
      const matchesFilter = filter === 'All' || status === filter;
      const matchesQuery = r.event.question.toLowerCase().includes(query.toLowerCase());
      return matchesFilter && matchesQuery;
    })
    .sort((a, b) => {
      if (sort === 'name') return a.event.question.localeCompare(b.event.question);
      return a.group.closesAt - b.group.closesAt;
    });

  return (
    <>
      <Title>What happens next?</Title>
      <Copy>Pick a question to trade or explore combinations with other related questions.</Copy>

      <Button secondary title="Get test AUSD / MON funds" onPress={onFaucet} />

      <Field label="Find a market" value={query} onChange={setQuery} />

      <Choice
        value={filter}
        options={[
          { value: 'Open', label: 'Open' },
          { value: 'All', label: 'All' },
          { value: 'Closed', label: 'Closed' },
          { value: 'Settled', label: 'Settled' },
        ]}
        onChange={setFilter}
      />

      <Choice
        value={sort}
        options={[
          { value: 'closing', label: 'Closing soon' },
          { value: 'name', label: 'Question name' },
        ]}
        onChange={setSort}
      />

      <View style={s.row}>
        <Button
          secondary
          title={loadingPrices || directory.busy ? 'Loading prices...' : 'Refresh all markets'}
          disabled={loadingPrices || directory.busy}
          onPress={() => setRevision(r => r + 1)}
        />
      </View>

      <Notice>{directory.error}</Notice>
      {failed.length > 0 && (
        <Notice>Some pools could not be refreshed. Use Refresh to retry.</Notice>
      )}

      <Copy small>
        {filteredRows.length} of {allRows.length} questions loaded
      </Copy>

      {/* Questions list */}
      {filteredRows.map(({ group, event, index, value }) => {
        const status = marketStatus(value, now / 1000);
        const quotes = value.prices.find(p => p.event === index);
        const closesDate = new Date(group.closesAt * 1000).toLocaleString();
        return (
          <Card key={`${group.namespace}:${index}`}>
            <View style={[s.row, { justifyContent: 'space-between' }]}>
              <Copy small>{group.label.toUpperCase()}</Copy>
              <Copy small>{status.toUpperCase()}</Copy>
            </View>

            <Heading>{event.question}</Heading>
            <Copy small>Closes {closesDate}</Copy>

            <View style={s.row}>
              <Button
                secondary
                title={`Yes · ${quotes?.yes ? amount(quotes.yes) : '--'} AUSD`}
                onPress={() => onSelectMarket(group, index)}
              />
              <Button
                secondary
                title={`No · ${quotes?.no ? amount(quotes.no) : '--'} AUSD`}
                onPress={() => onSelectMarket(group, index)}
              />
              <Button title="Trade & Details" onPress={() => onSelectMarket(group, index)} />
            </View>
          </Card>
        );
      })}

      {filteredRows.length === 0 && !loadingPrices && !directory.busy && (
        <Card>
          <Heading>No markets match your filter</Heading>
          <Copy>Try clearing search text or switching status to All.</Copy>
          <Button secondary title="Reset filters" onPress={() => { setQuery(''); setFilter('All'); }} />
        </Card>
      )}

      <Copy small>
        Prices are cost for 1 share in test AUSD including price impact, not probabilities. A winning share pays 1 test AUSD.
      </Copy>
    </>
  );
}
