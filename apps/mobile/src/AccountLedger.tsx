import { useEffect, useState } from 'react';
import { linkedWallets } from '../../web/src/wallet-links';
import type { PilotNamespace } from '../../web/src/pilot';
import type { MarketGroup } from '../../web/src/market-directory';
import { Ledger } from './Ledger';
import { externalWallet } from './wallet';
import { Button, Card, Choice, Copy, Heading, Notice, Title } from './ui';

export function AccountLedger({
  account,
  groups,
  history,
}: {
  account: string;
  groups: MarketGroup[];
  history: boolean;
}) {
  const [wallets, setWallets] = useState<string[] | null>(null);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [selectedNamespace, setSelectedNamespace] = useState<PilotNamespace>(() => groups[0]?.namespace ?? 'pilot');

  useEffect(() => {
    if (groups.length && !groups.some(g => g.namespace === selectedNamespace)) {
      setSelectedNamespace(groups[0].namespace);
    }
  }, [groups]);

  useEffect(() => {
    const c = new AbortController();
    setWallets(null);
    setError('');
    void linkedWallets(c.signal)
      .then(result => {
        if (result.account.toLowerCase() !== account.toLowerCase()) {
          throw new Error('Account changed. Sign in again.');
        }
        if (!c.signal.aborted) setWallets(result.wallets);
      })
      .catch(e => {
        if (!c.signal.aborted) setError(e.message);
      });
    return () => c.abort();
  }, [account, tick]);

  const poolOptions = groups.length
    ? groups.map(g => ({ value: g.namespace, label: g.label }))
    : [{ value: 'pilot' as PilotNamespace, label: 'Release events' }];

  return (
    <>
      <Title>Your {history ? 'history' : 'portfolio'}.</Title>
      <Copy>All your linked wallets and positions across Flurbo market pools.</Copy>
      <Notice>{error}</Notice>

      {/* Pool Switcher */}
      <Choice value={selectedNamespace} options={poolOptions} onChange={setSelectedNamespace} />

      <Button
        title={busy ? 'Connecting MetaMask...' : 'Link a trading wallet'}
        disabled={busy}
        onPress={() => {
          setBusy(true);
          void externalWallet.connect().finally(() => {
            setBusy(false);
            setTick(n => n + 1);
          });
        }}
      />
      <Button secondary title="Refresh wallets" onPress={() => setTick(n => n + 1)} />

      {!wallets && !error && <Copy>Loading linked trading wallets...</Copy>}
      {wallets?.length === 0 && (
        <Card>
          <Heading>No trading wallet linked</Heading>
          <Copy>
            Link your MetaMask wallet to see your prediction shares and redeem payouts.
          </Copy>
        </Card>
      )}

      {wallets?.map(wallet => (
        <Card key={wallet}>
          <Copy small>
            MetaMask wallet: {wallet.slice(0, 8)}...{wallet.slice(-6)}
          </Copy>
          <Ledger namespace={selectedNamespace} address={wallet} history={history} linked />
        </Card>
      ))}
    </>
  );
}
