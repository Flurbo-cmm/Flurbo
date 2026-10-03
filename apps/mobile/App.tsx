import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Animated, AppState, BackHandler, Easing, Image, KeyboardAvoidingView, Platform, ScrollView, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import * as Clipboard from 'expo-clipboard';
import Constants from 'expo-constants';
import { auth, initialize, storage } from './src/runtime';
import { externalWallet, type WalletKind } from './src/wallet';
import { transactions } from './src/transactions';
import { operations, prepareFaucet, type FaucetReview } from './src/operations';
import { type PilotNamespace } from '../web/src/pilot';
import { loadMarketDirectory, type MarketGroup } from '../web/src/market-directory';
import { Markets } from './src/Markets';
import { MarketDetail } from './src/MarketDetail';
import { CombinationBuilder } from './src/CombinationBuilder';
import { AccountLedger } from './src/AccountLedger';
import { WhatIf } from './src/WhatIf';
import { Settlement } from './src/Settlement';
import { Learning } from './src/Advanced';
import { Legacy } from './src/Legacy';
import { balanceTarget } from './src/config';
import { formatAmount, readBalance, type WalletBalance } from './src/balance';
import { readPerplContext, type PerplContext } from './src/perpl';
import { api } from './src/api';
import { useRequest } from './src/hooks';
import { AccessView } from './src/AccessView';
import { Button, Card, Choice, Copy, External, Field, Heading, Notice, Title, colors, s } from './src/ui';

type Page =
  | 'markets'
  | 'detail'
  | 'combination'
  | 'whatif'
  | 'portfolio'
  | 'history'
  | 'wallet'
  | 'tools'
  | 'settlement'
  | 'learning'
  | 'legacy'
  | 'withdraw'
  | 'perpl'
  | 'transaction'
  | 'about';

function Wallet({ kind, onWithdraw }: { kind: WalletKind; onWithdraw: () => void }) {
  const login = useSyncExternalStore(auth.subscribe, auth.getSnapshot);
  const wallet = useSyncExternalStore(externalWallet.subscribe, externalWallet.getSnapshot);
  const operation = useSyncExternalStore(operations.subscribe, operations.getSnapshot);
  const owner = wallet.address;
  const balance = useRequest<WalletBalance>();
  const faucet = useRequest<FaucetReview>();
  const [notice, setNotice] = useState('');

  const refresh = () => owner && void balance.run(signal => readBalance(balanceTarget, owner, signal), true);

  useEffect(() => {
    balance.cancel(true);
    faucet.cancel(true);
    refresh();
    return () => {
      balance.cancel();
      faucet.cancel();
    };
  }, [owner]);

  return (
    <>
      <Title>Your wallet.</Title>
      <Copy>Mera is your Flurbo account. MetaMask is your trading wallet.</Copy>
      <Card>
        <Heading>Flurbo account</Heading>
        <Copy>{login.address}</Copy>
        <Button
          secondary
          title="Copy Mera address"
          onPress={() => void Clipboard.setStringAsync(login.address!).then(() => setNotice('Mera address copied.'))}
        />
        <Copy small>Your Mera passkey is for account access only. Funds and trades use MetaMask.</Copy>
        <Notice>{login.error || login.notice}</Notice>
      </Card>
      {kind === 'metamask' && (
        <Card>
          <Heading>MetaMask trading wallet</Heading>
          <Copy>{wallet.address ?? 'Connect your Monad testnet account.'}</Copy>
          <Button
            title={wallet.busy ? 'Waiting for MetaMask...' : 'Connect MetaMask'}
            disabled={wallet.busy}
            onPress={() => void externalWallet.connect()}
          />
          {wallet.address && (
            <Button
              title="Disconnect MetaMask"
              secondary
              onPress={() =>
                void externalWallet
                  .disconnect()
                  .catch(() => setNotice('Disconnected locally. Check MetaMask connections if needed.'))
              }
            />
          )}
          <Notice>{wallet.error}</Notice>
          <Copy small>Connecting MetaMask does not create or replace your Flurbo account.</Copy>
        </Card>
      )}
      {owner && (
        <Card>
          <Copy small>SELECTED TRADING WALLET</Copy>
          <Copy>{owner}</Copy>
          <Button
            secondary
            title="Copy trading address"
            onPress={() => void Clipboard.setStringAsync(owner).then(() => setNotice('Trading address copied.'))}
          />
          <Heading>{balance.value ? formatAmount(balance.value.ausd, 6) : 'Unavailable'} test AUSD</Heading>
          <Copy>{balance.value ? formatAmount(balance.value.mon, 18) : 'Unavailable'} test MON</Copy>
          <Button
            secondary
            title={balance.busy ? 'Cancel balance check' : 'Refresh balance'}
            onPress={() => (balance.busy ? balance.cancel() : refresh())}
          />
          <Notice>{balance.error}</Notice>
          <Copy small>AUSD funds trades. MON pays network fees. Never send mainnet assets to these testnet addresses.</Copy>
          <External title="Get test MON" url="https://faucet.monad.xyz" />
          <Button
            title="Review test AUSD request"
            disabled={faucet.busy || operation.busy || !!operation.pending}
            onPress={() => void faucet.run(() => prepareFaucet(kind, owner), true)}
          />
          <Notice>{faucet.error}</Notice>
          {faucet.value && (
            <>
              <Copy small>
                Request test AUSD for {faucet.value.tx.from}. Maximum fee: {faucet.value.fee} test MON. Faucet limits may
                apply. No allowance is granted.
              </Copy>
              <Button
                title="Confirm faucet request"
                disabled={operation.busy || !!operation.pending}
                onPress={() => void operations.faucet(kind, faucet.value!, () => faucet.isCurrent(faucet.value!))}
              />
            </>
          )}
          <Button secondary title="Withdraw available AUSD" onPress={onWithdraw} />
        </Card>
      )}
      <Notice>{notice}</Notice>
      <Button secondary title="Sign out of Flurbo" onPress={() => void auth.signOut()} />
    </>
  );
}

function Pending() {
  const tx = useSyncExternalStore(transactions.subscribe, transactions.getSnapshot);
  const op = useSyncExternalStore(operations.subscribe, operations.getSnapshot);
  const [hash, setHash] = useState('');
  const [error, setError] = useState('');
  const pending = tx.pending ?? op.pending?.value;
  const busy = tx.busy || op.busy;

  useEffect(() => {
    if (!pending?.hash) return;
    let polls = 0;
    const tick = setInterval(() => {
      if (AppState.currentState === 'active' && ++polls <= 5) {
        void (tx.pending ? transactions.check() : operations.check());
      }
      if (polls >= 5) clearInterval(tick);
    }, 6000);
    return () => clearInterval(tick);
  }, [pending?.hash]);

  if (!pending) return <Notice>{tx.notice || op.notice}</Notice>;

  return (
    <Card>
      <Heading>Transaction in progress</Heading>
      <Copy>{tx.pending ? tx.notice : op.notice}</Copy>
      {pending.hash ? (
        <External title="View on Monad explorer" url={`https://testnet.monadscan.com/tx/${pending.hash}`} />
      ) : (
        <>
          <Field label="Transaction hash from wallet activity" value={hash} onChange={setHash} />
          <Button
            secondary
            title="Attach transaction hash"
            disabled={busy}
            onPress={() =>
              void (tx.pending ? transactions.attachHash(hash) : operations.attachHash(hash)).catch(e =>
                setError(e.message)
              )
            }
          />
        </>
      )}
      <Button
        title={busy ? 'Checking...' : 'Check confirmation'}
        disabled={busy}
        onPress={() => void (tx.pending ? transactions.check() : operations.check())}
      />
      <Notice>{error}</Notice>
      <Copy small>Do not repeat this action while its outcome is unknown. Tracking stays saved when you leave this screen.</Copy>
    </Card>
  );
}

function Perpl() {
  const data = useRequest<PerplContext>();
  useEffect(() => {
    void data.run(signal => readPerplContext(balanceTarget.token, signal));
  }, []);
  return (
    <>
      <Title>Perpl.</Title>
      <Copy>Live testnet perpetual market prices.</Copy>
      <Notice>{data.error}</Notice>
      <Button secondary title="Refresh prices" onPress={() => void data.run(signal => readPerplContext(balanceTarget.token, signal))} />
      {data.value?.markets.map(m => (
        <Card key={m.id}>
          <Heading>{m.name}</Heading>
          <Copy>{(m.mark / 10 ** m.decimals).toLocaleString()} AUSD</Copy>
          <Copy small>{m.open ? 'Open' : 'Closed'}</Copy>
        </Card>
      ))}
      <Notice>Perpl trading is not enabled in Flurbo yet. It requires Perpl to approve the integration origin. This screen only reads prices.</Notice>
    </>
  );
}

function TransactionLookup() {
  const [hash, setHash] = useState('');
  const read = useRequest<any>();
  return (
    <>
      <Title>Follow a transaction.</Title>
      <Field label="Monad testnet transaction hash" value={hash} onChange={setHash} />
      <Button
        title="Check status"
        disabled={read.busy || !/^0x[0-9a-f]{64}$/i.test(hash)}
        onPress={() => void read.run(signal => api('/api/transaction?hash=' + hash, undefined, signal), true)}
      />
      <Notice>{read.error}</Notice>
      {read.value && (
        <Card>
          <Heading>{read.value.status}</Heading>
          <Copy small>{read.value.sender}</Copy>
          <External title="View transaction" url={`https://testnet.monadscan.com/tx/${hash}`} />
        </Card>
      )}
    </>
  );
}

function ContourLoadingScreen({ initError, onRetry }: { initError: string | null; onRetry: () => void }) {
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 1200,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: 1200,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ])
    );
    animation.start();
    return () => animation.stop();
  }, [pulse]);

  const scale = pulse.interpolate({
    inputRange: [0, 1],
    outputRange: [0.96, 1.04],
  });

  const opacity = pulse.interpolate({
    inputRange: [0, 1],
    outputRange: [0.75, 1],
  });

  return (
    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, minHeight: 380 }}>
      <Animated.View style={{ transform: [{ scale }], opacity, marginBottom: 24, alignItems: 'center' }}>
        <Image
          source={require('./assets/brand/mark.png')}
          style={{ width: 84, height: 84 }}
          resizeMode="contain"
        />
      </Animated.View>
      <Text style={{ fontSize: 24, fontWeight: '700', letterSpacing: -1, color: colors.ink, marginBottom: 6 }}>
        flurbo<Text style={{ color: colors.lime }}>.</Text>
      </Text>
      <Text style={{ fontSize: 14, color: colors.muted, letterSpacing: 0.2, marginBottom: 16 }}>
        {initError ? 'Connection interrupted' : 'Connecting to Monad testnet...'}
      </Text>
      {initError ? (
        <View style={{ width: '100%', maxWidth: 360, marginTop: 12, gap: 12 }}>
          <Notice>{initError}</Notice>
          <Button title="Retry connection" onPress={onRetry} />
        </View>
      ) : (
        <Copy small>Restoring account session and market directory</Copy>
      )}
    </View>
  );
}

function Main() {
  const login = useSyncExternalStore(auth.subscribe, auth.getSnapshot);
  const wallet = useSyncExternalStore(externalWallet.subscribe, externalWallet.getSnapshot);

  const [ready, setReady] = useState(false);
  const [initError, setInitError] = useState('');
  const [page, setPage] = useState<Page>('markets');
  const [groups, setGroups] = useState<MarketGroup[]>([]);
  const [selectedGroup, setSelectedGroup] = useState<MarketGroup | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<number>(0);
  const [accessApproved, setAccessApproved] = useState<boolean | null>(null);

  async function boot() {
    setInitError('');
    try {
      await initialize();
      transactions.restore();
      operations.restore();
      setReady(true);
    } catch {
      setInitError('The app could not restore account or transaction tracking. Restart before trading. Your passkey has not been replaced.');
    }
  }

  useEffect(() => {
    void boot();
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'background' && !auth.getSnapshot().busy) auth.lockSigning();
      if (state === 'active') auth.checkExpiry();
    });
    return () => {
      subscription.remove();
      auth.lockSigning();
    };
  }, []);

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (page === 'combination') {
        setPage('detail');
        return true;
      }
      if (page === 'detail') {
        setPage('markets');
        return true;
      }
      if (page !== 'markets') {
        setPage('markets');
        return true;
      }
      return false;
    });
    return () => subscription.remove();
  }, [page]);

  // Load directory and access status once signed in
  useEffect(() => {
    if (!login.address) {
      setAccessApproved(null);
      setPage('markets');
      return;
    }
    void externalWallet.initialize();

    const c = new AbortController();
    void loadMarketDirectory(c.signal)
      .then(list => {
        if (!c.signal.aborted) {
          setGroups(list);
          if (!selectedGroup && list.length > 0) setSelectedGroup(list[0]);
        }
      })
      .catch(() => undefined);

    // Verify preview access with the server
    void api<{ approved: boolean }>('/api/account/access', undefined, c.signal)
      .then(res => {
        if (!c.signal.aborted) setAccessApproved(res.approved === true);
      })
      .catch(() => undefined);

    return () => c.abort();
  }, [login.address]);

  const kind: WalletKind = 'metamask';
  const allowed = Platform.OS !== 'web' && Constants.expoConfig?.extra?.passkeyRpId === 'flurbo.singu.online';

  const signIn = async (signup = false, another = false) => {
    await auth.authenticate(signup ? 'signup' : 'login', 'Flurbo account', another);
    await storage.flush().catch(() => setInitError('Account metadata could not be saved. Restart before trading.'));
    if (AppState.currentState !== 'active') auth.lockSigning();
  };

  const activeNamespace: PilotNamespace = selectedGroup?.namespace ?? groups[0]?.namespace ?? 'pilot';

  return (
    <SafeAreaView style={s.screen} edges={['top', 'bottom']}>
      <StatusBar style="dark" />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={[s.row, { paddingHorizontal: 22, paddingVertical: 14, justifyContent: 'space-between', alignItems: 'center' }]}>
          <View style={[s.row, { alignItems: 'center', gap: 10 }]}>
            <Image
              source={require('./assets/brand/mark.png')}
              style={{ width: 32, height: 32 }}
              resizeMode="contain"
            />
            <Text style={{ fontSize: 28, fontWeight: '700', letterSpacing: -1.5, color: colors.ink }}>
              flurbo<Text style={{ color: colors.lime }}>.</Text>
            </Text>
          </View>
          <View style={{ backgroundColor: colors.ink, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 6 }}>
            <Text style={{ fontSize: 11, fontWeight: '700', color: colors.lime, letterSpacing: 0.6 }}>MONAD TESTNET</Text>
          </View>
        </View>

        <ScrollView key={page} keyboardShouldPersistTaps="handled" contentContainerStyle={s.content}>
          {!ready ? (
            <ContourLoadingScreen initError={initError} onRetry={() => void boot()} />
          ) : !login.address ? (
            <>
              <View style={{ alignItems: 'center', marginVertical: 12 }}>
                <Image
                  source={require('./assets/brand/mark.png')}
                  style={{ width: 64, height: 64, marginBottom: 12 }}
                  resizeMode="contain"
                />
                <Copy small>ONE SHARED MARKET</Copy>
                <Title>A view worth combining.</Title>
              </View>
              <Copy>Explore individual predictions and see how the market prices the relationships between events.</Copy>
              <Card>
                <Heading>Your account starts with a passkey.</Heading>
                <Copy>
                  Sign in using the same passkey you use on flurbo.singu.online. MetaMask can be connected for trading
                  after sign-in.
                </Copy>
                <Button
                  title={login.busy ? 'Opening passkey...' : 'Sign in with passkey'}
                  disabled={login.busy || !allowed}
                  onPress={() => void signIn()}
                />
                <Button
                  secondary
                  title="Create a Flurbo account"
                  disabled={login.busy || !allowed}
                  onPress={() => void signIn(true)}
                />
                <Button
                  secondary
                  title="Choose another passkey"
                  disabled={login.busy || !allowed}
                  onPress={() => void signIn(false, true)}
                />
                <Notice>{login.error || login.notice}</Notice>
                {!allowed && (
                  <Notice>
                    Install the signed Flurbo build configured for flurbo.singu.online. Expo Go and browser previews
                    cannot unlock this account.
                  </Notice>
                )}
                <Copy small>
                  Android: use Google Password Manager with your existing Google account and screen lock. A localhost
                  passkey belongs to a different site.
                </Copy>
              </Card>
            </>
          ) : accessApproved === false ? (
            /* Access Gate Workflow */
            <AccessView onApproved={() => setAccessApproved(true)} />
          ) : (
            <>
              <Notice>{initError}</Notice>
              <Pending />

              {page === 'markets' && (
                <Markets
                  onSelectMarket={(group, eventIdx) => {
                    setSelectedGroup(group);
                    setSelectedEvent(eventIdx);
                    setPage('detail');
                  }}
                  onFaucet={() => setPage('wallet')}
                />
              )}

              {page === 'detail' && selectedGroup && (
                <MarketDetail
                  group={selectedGroup}
                  eventIndex={selectedEvent}
                  kind={kind}
                  onCombine={() => setPage('combination')}
                  onWhatIf={() => setPage('whatif')}
                  onBack={() => setPage('markets')}
                  onPortfolio={() => setPage('portfolio')}
                />
              )}

              {page === 'combination' && selectedGroup && (
                <CombinationBuilder
                  group={selectedGroup}
                  initialEvent={selectedEvent}
                  kind={kind}
                  onBack={() => setPage('detail')}
                  onPortfolio={() => setPage('portfolio')}
                />
              )}

              {page === 'whatif' && <WhatIf namespace={activeNamespace} />}

              {(page === 'portfolio' || page === 'history') && (
                <AccountLedger
                  key={`${page}:${login.address}`}
                  groups={groups}
                  account={login.address!}
                  history={page === 'history'}
                />
              )}

              {page === 'wallet' && <Wallet kind={kind} onWithdraw={() => setPage('withdraw')} />}
              {page === 'settlement' && <Settlement namespace={activeNamespace} kind={kind} />}
              {page === 'learning' && <Learning />}
              {(page === 'legacy' || page === 'withdraw') && (
                <Legacy key={page} kind={kind} initialAction={page === 'withdraw' ? 'withdraw' : 'buy'} />
              )}
              {page === 'perpl' && <Perpl />}
              {page === 'transaction' && <TransactionLookup />}

              {page === 'tools' && (
                <>
                  <Title>Explore more.</Title>
                  {(
                    [
                      ['settlement', 'Resolution and evidence'],
                      ['legacy', 'Earlier pools and receipts'],
                      ['learning', 'Learning experiment'],
                      ['transaction', 'Check a transaction'],
                      ['perpl', 'Perpl prices'],
                      ['about', 'About Flurbo'],
                    ] as [Page, string][]
                  ).map(([p, title]) => (
                    <Button key={p} secondary title={title} onPress={() => setPage(p)} />
                  ))}
                </>
              )}

              {page === 'about' && (
                <>
                  <View style={{ alignItems: 'center', marginVertical: 14 }}>
                    <Image
                      source={require('./assets/brand/mark.png')}
                      style={{ width: 56, height: 56, marginBottom: 12 }}
                      resizeMode="contain"
                    />
                    <Title>One pool. More possibilities.</Title>
                  </View>
                  <Copy>
                    Flurbo brings individual and combined predictions into one shared market, letting you see how the
                    market prices relationships between events.
                  </Copy>
                  <Copy>
                    Practice markets use test AUSD on Monad testnet. Public blockchain transactions reveal wallet
                    activity. This preview does not offer private participation or AI settlement.
                  </Copy>
                  <Copy small>Version {Constants.expoConfig?.version}. Passkey host: flurbo.singu.online.</Copy>
                </>
              )}

              {!['markets', 'detail', 'combination', 'whatif', 'portfolio', 'history', 'wallet', 'tools'].includes(page) && (
                <Button secondary title="Back to more" onPress={() => setPage('tools')} />
              )}
            </>
          )}
        </ScrollView>

        {ready && login.address && accessApproved !== false && (
          <View style={{ borderTopWidth: 1, borderColor: colors.line, padding: 8 }}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 5 }}>
              <Choice
                value={['detail', 'combination'].includes(page) ? 'markets' : page}
                options={[
                  { value: 'markets', label: 'Markets' },
                  { value: 'whatif', label: 'What if' },
                  { value: 'portfolio', label: 'Portfolio' },
                  { value: 'history', label: 'History' },
                  { value: 'wallet', label: 'Wallet' },
                  { value: 'tools', label: 'More' },
                ]}
                onChange={val => {
                  setPage(val);
                }}
              />
            </ScrollView>
          </View>
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <Main />
    </SafeAreaProvider>
  );
}
