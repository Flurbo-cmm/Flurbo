import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const trade = (hash: string, index: number, block: number, isBuy: boolean, quantity: string, collateralAmount: string) =>
  ({ name: 'Traded', hash, index, block, args: { trader: '0x' + '11'.repeat(20), scope: 1, mask: '2', isBuy, quantity, collateralAmount } });

test('the sell review shows what was paid, what is received and the difference', { skip: !process.env.FLURBO_TEST_PLAYWRIGHT }, async () => {
  const { chromium } = await import(pathToFileURL(process.env.FLURBO_TEST_PLAYWRIGHT!).href);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.FLURBO_TEST_BROWSER });
  const pool = '0x' + '44'.repeat(20), owner = '0x' + '11'.repeat(20);
  const account = '0x' + '22'.repeat(20), id = `${pool}-0`, now = Math.floor(Date.now() / 1000);
  const market = { id, pool, poolTitle: 'Source pool', eventIndex: 0, question: 'Will the test block contain a transaction?', route: 'mechanical',
    closesAt: now + 7200, observationEndsAt: now + 10800 };
  const logs = [trade('0x' + '01'.repeat(32), 0, 10, true, '4000000', '2000000'), trade('0x' + '02'.repeat(32), 0, 11, true, '2000000', '1400000'),
    trade('0x' + '03'.repeat(32), 0, 12, false, '1000000', '500000')];
  let history = 'full';
  const errors: string[] = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on('pageerror', (error: Error) => errors.push(error.message));
          await page.addInitScript((wallet: string) => {
        const listeners = new Map<string, Set<() => void>>();
        (window as any).walletEvent = (event: string) => listeners.get(event)?.forEach(listener => listener());
        (window as any).ethereum = { isMetaMask: true, request: async ({ method }: any) => {
          if (method === 'eth_chainId') return '0x279f';
          if (method === 'eth_requestAccounts') {
            sessionStorage.setItem('hybrid.permission', '1');
            return [wallet];
          }
          if (method === 'eth_accounts') return sessionStorage.getItem('hybrid.permission')
            ? [sessionStorage.getItem('hybrid.selectedWallet') || wallet] : [];
          if (method === 'eth_sendTransaction') {
            const reject = sessionStorage.getItem('hybrid.reject');
            if (reject) {
              sessionStorage.removeItem('hybrid.reject');
              if (reject === 'wrapped') throw { code: -32603, message: 'Internal JSON-RPC error.',
                data: { originalError: { code: 4001, message: 'User denied transaction signature.' } } };
              if (reject === 'unknown') throw Error('Wallet connection lost');
              throw Object.assign(Error('Rejected'), { code: 4001 });
            }
            const count = Number(sessionStorage.getItem('hybrid.sends') || '0') + 1;
            sessionStorage.setItem('hybrid.sends', String(count));
            return '0x' + count.toString(16).padStart(64, '0');
          }
          if (method === 'eth_getTransactionReceipt')
            return sessionStorage.getItem('hybrid.receiptReady') ? { status: '0x1' } : null;
          throw Error(`Unexpected wallet method: ${method}`);
        }, on: (event: string, listener: () => void) => {
          if (!listeners.has(event)) listeners.set(event, new Set());
          listeners.get(event)!.add(listener);
        }, removeListener: (event: string, listener: () => void) => listeners.get(event)?.delete(listener) };
      }, owner);
    await page.route('**/*', async (route: any) => {
      const url = new URL(route.request().url()), path = url.pathname;
      if (path === '/api/auth/session') return route.fulfill({ json: { session: { address: account, method: 'passkey', expiresAt: Date.now() + 3600_000 } } });
      if (path === '/api/account/access') return route.fulfill({ json: { approved: true, testingTools: false } });
      if (path === '/api/account/wallets') return route.fulfill({ json: { account, wallets: [owner.toLowerCase()] } });
      if (path === '/api/account/portfolio-sources') return route.fulfill({ json: { account, wallets: [owner.toLowerCase()], agentWallets: [] } });
      if (path === '/api/market-directory') return route.fulfill({ json: { schema: 'flurbo.market-directory.v1', markets: [], oracleMarkets: [], hybridMarkets: [market] } });
      if (path === `/api/hybrid/${id}/market`) return route.fulfill({ json: { prices: { yes: '500000', no: '500000' }, marketNow: now, funded: true, resolved: false } });
      if (path === `/api/hybrid/${id}/price-history`) return route.fulfill({ json: { pool, sampling: 'current', points: [] } });
      if (path === `/api/hybrid/pool/${pool}/history`) return route.fulfill({ json: { complete: true, logs: history === 'full' ? logs : [logs[2]] } });
      if (path === `/api/hybrid/${id}`) return route.fulfill({ json: { ...market, schema: 'flurbo.hybrid-snapshot.v1', resolver: pool, eventHash: '0x' + '33'.repeat(32),
        rulesHash: '0x' + '55'.repeat(32), adapter: pool, source: { adapter: 'evm-rpc.v1', publisher: 'Test RPC' }, marketNow: now, funded: true, resolved: false, delivered: false,
        assertionDeadline: now + 14400, reportDeadline: now + 86400, bondAtoms: '1000000', phase: 0, proposal: 0, counter: 0, result: 0, challengeUntil: 0, arbitrationUntil: 0,
        requestId: '0x' + '00'.repeat(32), sourceCaseId: '0x' + '00'.repeat(32), proposalEvidenceURI: null, reality: null,
        user: url.searchParams.has('wallet') ? { wallet: owner, noShares: '0', yesShares: '5000000', cashAtoms: '10000000', allowanceAtoms: '0', bondAllowanceAtoms: '0', bondCreditsAtoms: '0' } : null } });
      if (path === `/api/hybrid/${id}/action`) {
        const { action, input } = route.request().postDataJSON(), quantity = BigInt(input?.quantity || 0);
        if (action === 'quote') return route.fulfill({ json: { action, buyAtoms: (quantity / 2n).toString(), maxCostAtoms: (quantity / 2n).toString(), sellAtoms: (quantity / 3n).toString(),
          minProceedsAtoms: (quantity / 3n).toString(), cashAtoms: '10000000', allowanceAtoms: '0', holdingsAtoms: '5000000' } });
      }
      if (path.startsWith('/api/')) return route.fulfill({ status: 503, json: { error: 'Unavailable fixture' } });
      const relative = path.startsWith('/assets/') ? path.slice(1) : 'index.html';
      return route.fulfill({ body: await readFile(new URL('../dist/' + relative, import.meta.url)),
        contentType: relative.endsWith('.js') ? 'text/javascript' : relative.endsWith('.css') ? 'text/css' : relative.endsWith('.woff2') ? 'font/woff2' : 'text/html' });
    });
   
    await page.goto(`https://flurbo.singu.online/markets/hybrid/${pool}/0`);
    const ticket = page.getByRole('region', { name: 'Trade this market' });
    await ticket.getByRole('button', { name: 'Connect MetaMask' }).click();
    await ticket.getByText('10 test AUSD').waitFor();
    await ticket.getByRole('radio', { name: 'Sell' }).click();
    await ticket.getByLabel('Shares', { exact: true }).fill('5');
    const figures = ticket.getByRole('term').filter({ hasText: 'You paid' });
    await figures.waitFor();
    const text = await ticket.getByLabel('Profit or loss on this sale').innerText();
    assert.match(text, /You paid\s*2\.833334 test AUSD/);
    assert.match(text, /You receive about\s*1\.666666 test AUSD/);
    assert.match(text, /Loss\s*-1\.166668 test AUSD/);
    history = 'partial';
    await page.reload();
    await ticket.getByRole('button', { name: 'Switch wallet' }).waitFor();
    await ticket.getByRole('radio', { name: 'Sell' }).click();
    await ticket.getByLabel('Shares', { exact: true }).fill('5');
    await ticket.getByText('Cost unavailable').waitFor();
    assert.equal(await ticket.getByLabel('Profit or loss on this sale').count(), 0);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
