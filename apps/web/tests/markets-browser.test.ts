import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const owner = '0x' + '11'.repeat(20), hash = '0x' + '44'.repeat(32);

test('the directory lists each hybrid and oracle market once, never as a pilot card, and the oracle flow still works', { skip: !process.env.FLURBO_TEST_PLAYWRIGHT }, async () => {
  const { chromium } = await import(pathToFileURL(process.env.FLURBO_TEST_PLAYWRIGHT!).href);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.FLURBO_TEST_BROWSER });
  const loginAddress = '0x' + '99'.repeat(20), now = Math.floor(Date.now() / 1000);
  const hybridPool = '0x' + '22'.repeat(20), namespace = 'practice-' + '22'.repeat(20);
  const hybridMarkets = ['Will the night market open?', 'Will the concert sell out?'].map((question, eventIndex) => ({ id: `${hybridPool}-${eventIndex}`,
    pool: hybridPool, poolTitle: 'Agent pool', eventIndex, question, route: 'mechanical', closesAt: now + 7200, observationEndsAt: now + 10800 }));
  const oraclePool = '0x' + '44'.repeat(20), oracleClosesAt = now + 7200;
  const oracleMarkets = [0, 1].map(i => ({ id: `oracle-smoke-${i}`, pool: oraclePool, poolTitle: 'Source pool', eventIndex: i,
    question: i === 0 ? 'Will the block be even?' : 'Will the block contain a transaction?', closesAt: oracleClosesAt, observationEndsAt: oracleClosesAt + 3600 }));
  let oracleAnswerActive = false, arbitrationPrepared = false, login = true, linked = false, sessionReads = 0;
  const namespaceReads: string[] = [], errors: string[] = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on('pageerror', (error: Error) => errors.push(error.message));
    await page.addInitScript(({ owner, hash }: any) => {
      const listeners = new Map<string, Set<() => void>>();
      (window as any).ethereum = { isMetaMask: true,
        on: (name: string, fn: () => void) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name)!.add(fn); },
        removeListener: (name: string, fn: () => void) => listeners.get(name)?.delete(fn),
        request: async ({ method }: any) => {
          if (method === 'wallet_requestPermissions') return [];
          if (method === 'personal_sign') { sessionStorage.setItem('link.signatures', String(Number(sessionStorage.getItem('link.signatures') || 0) + 1)); return '0x' + '11'.repeat(65); }
          if (['eth_accounts', 'eth_requestAccounts'].includes(method)) return [owner];
          if (method === 'eth_chainId') return '0x279f';
          if (method === 'eth_getBlockByNumber') return { number: '0x65', hash };
          throw new Error(method);
        } };
    }, { owner, hash });
    await page.route('**/*', async (route: any) => {
      const url = new URL(route.request().url()), path = url.pathname;
      if (path.startsWith('/api/pilot/') || path.startsWith('/api/practice-')) namespaceReads.push(path);
      if (path === '/api/market-directory') return route.fulfill({ json: { schema: 'flurbo.market-directory.v1',
        markets: [{ namespace, label: 'Agent pool', pool: hybridPool, closesAt: now + 7200 }], oracleMarkets, hybridMarkets } });
      if (/^\/api\/hybrid\/0x[0-9a-f]{40}-[01]\/market$/.test(path)) return route.fulfill({ json: { schema: 'flurbo.hybrid-market.v1', id: path.split('/')[3],
        pool: hybridPool, marketNow: now, funded: true, resolved: false, prices: { yes: '500000', no: '500000' } } });
      if (/^\/api\/oracle\/oracle-smoke-[01]\/price-history$/.test(path)) return route.fulfill({ json: { pool: oraclePool, sampling: 'current', points: [{ timestamp: now, blockNumber: '10', prices: [{ event: 0, yes: '450000', no: '550000' }] }] } });
      if (/^\/api\/oracle\/oracle-smoke-[01]\/market$/.test(path)) return route.fulfill({ json: { schema: 'flurbo.oracle-market.v1', id: path.split('/')[3], pool: oraclePool, marketNow: Math.floor(Date.now() / 1000), funded: true, resolved: false, prices: { yes: '450000', no: '550000' } } });
      if (/^\/api\/oracle\/oracle-smoke-[01]$/.test(path)) return route.fulfill({ json: { ...oracleMarkets.find(m => m.id === path.split('/')[3]), schema: 'flurbo.oracle-snapshot.v1', reality: owner, arbitrator: owner, resolver: owner, relay: owner, questionId: hash, questionTxHash: hash, historyHash: hash, answer: oracleAnswerActive ? hash : null, answerLabel: oracleAnswerActive ? 'No' : null, bondWei: oracleAnswerActive ? '100000000000000' : '0', minBondWei: '100000000000000', nextBondWei: '200000000000000', disputeFeeWei: '1000000000000000', opensAt: oracleClosesAt + 3600, finalizesAt: oracleAnswerActive ? oracleClosesAt + 7200 : 0, sourceNow: oracleAnswerActive ? oracleClosesAt + 3700 : Math.floor(Date.now() / 1000), marketNow: Math.floor(Date.now() / 1000), finalized: false, pendingArbitration: false, dispute: null, reportDeadline: oracleClosesAt + 86400, phase: 0, reported: 0, funded: true, resolved: false, user: url.searchParams.has('wallet') ? { wallet: owner, creditedEthWei: '0', noShares: '0', yesShares: '0', cashAtoms: '10000000', allowanceAtoms: '0' } : null } });
      if (/^\/api\/oracle\/oracle-smoke-[01]\/action$/.test(path)) { const action = route.request().postDataJSON().action; if (action === 'position') return route.fulfill({ json: { holdingsAtoms: '0' } }); if (action === 'quote') return route.fulfill({ json: { action: 'quote', buyAtoms: '450000', maxCostAtoms: '454500', sellAtoms: null, allowanceAtoms: '0', cashAtoms: '10000000', holdingsAtoms: '0' } }); arbitrationPrepared = action === 'arbitrate'; return route.fulfill({ json: { action: 'arbitrate', reason: 'Review the Kleros fee', transaction: { chainId: 11155111, from: owner, to: owner, data: '0x', value: '0x1' } } }); }
      if (path === '/api/account/wallets') return route.fulfill({ json: { account: loginAddress, wallets: linked ? [owner] : [] } });
      if (path === '/api/account/portfolio-sources') return route.fulfill({ json: { account: loginAddress, wallets: linked ? [owner] : [], agentWallets: [] } });
      if (path === '/api/account/wallets/challenge') return route.fulfill({ json: { id: 'fixture-proof', message: 'Link this MetaMask wallet to your Flurbo account; no transaction.' } });
      if (path === '/api/account/wallets/verify') { linked = true; return route.fulfill({ json: { account: loginAddress, wallets: [owner] } }); }
      if (path === '/api/account/access') return route.fulfill({ json: { approved: true, testingTools: false } });
      if (path === '/api/auth/session') { sessionReads++; return route.fulfill({ json: { session: login ? { address: loginAddress, method: 'passkey', expiresAt: Date.now() + 3600_000 } : null } }); }
      if (path.startsWith('/api/')) return route.fulfill({ status: 503, json: { error: 'Unavailable fixture service' } });
      const relative = path.startsWith('/assets/') ? path.slice(1) : 'index.html';
      return route.fulfill({ body: await readFile(new URL('../dist/' + relative, import.meta.url)), contentType: relative.endsWith('.js') ? 'text/javascript' : relative.endsWith('.css') ? 'text/css' : relative.endsWith('.woff2') ? 'font/woff2' : 'text/html' });
    });
    await page.goto('https://flurbo.singu.online/login');
    await page.waitForURL('**/access'); await page.getByRole('link', { name: 'Explore markets', exact: true }).click(); await page.waitForURL('**/markets');
    for (const question of [...hybridMarkets, ...oracleMarkets].map(m => m.question)) {
      await page.getByRole('heading', { name: question, exact: true }).waitFor();
      assert.equal(await page.getByRole('heading', { name: question, exact: true }).count(), 1, question);
    }
    assert.equal(await page.locator('.market-card').count(), 4, 'two hybrid and two oracle cards, the agent pool is not listed again');
    assert.equal(await page.locator('a[href^="/markets/practice-"], a[href^="/markets/pilot"]').count(), 0);
    assert.deepEqual(namespaceReads, [], 'the directory never reads pilot or namespace routes');
    await page.getByRole('link', { name: 'No: Will the concert sell out?', exact: true }).waitFor();
    assert.equal(await page.getByRole('link', { name: 'No: Will the concert sell out?', exact: true }).getAttribute('href'), `/markets/hybrid/${hybridPool}/1?answer=no`);
    await page.waitForFunction(() => { const root = document.querySelector('.app-root') as HTMLElement | null; return !!root && !root.inert && !document.querySelector('.contour-loader'); });
    await page.getByRole('textbox', { name: 'Search markets' }).fill('concert');
    await page.waitForFunction(() => document.querySelectorAll('.market-card').length === 1);
    await page.getByRole('textbox', { name: 'Search markets' }).fill('');
    await page.getByRole('heading', { name: 'Will the block be even?', exact: true }).waitFor();
    // The oracle market page keeps its own wallet link, ticket and Kleros challenge.
    await page.getByRole('link', { name: 'No: Will the block be even?', exact: true }).click();
    assert.equal(new URL(page.url()).pathname, '/markets/oracle/oracle-smoke-0');
    await page.getByRole('heading', { name: 'Your prediction', exact: true }).waitFor();
    assert.equal(await page.getByRole('heading', { name: 'Challenge this answer' }).count(), 0);
    assert.equal(await page.getByRole('radio', { name: 'No' }).getAttribute('aria-checked'), 'true');
    await page.getByRole('region', { name: 'Price history', exact: true }).waitFor();
    await page.getByRole('tab', { name: 'Timeline' }).click();
    await page.getByRole('heading', { name: 'From prediction to payout' }).waitFor();
    await page.getByRole('button', { name: 'Link selected wallet' }).click();
    await page.getByText('MetaMask connected. This wallet signs each transaction you review.').waitFor();
    assert.equal(linked, true);
    assert.equal(Number(await page.evaluate(() => sessionStorage.getItem('link.signatures'))), 1);
    await page.reload();
    await page.getByRole('button', { name: 'Switch wallet' }).waitFor();
    assert.equal(Number(await page.evaluate(() => sessionStorage.getItem('link.signatures'))), 1);
    await page.getByRole('button', { name: 'Allow payment' }).waitFor();
    oracleAnswerActive = true;
    await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
    await page.getByRole('heading', { name: 'Challenge this answer' }).waitFor();
    await page.getByRole('button', { name: 'Review Kleros challenge fee' }).click();
    assert.equal(arbitrationPrepared, true);
    await page.getByRole('heading', { name: 'Review on Sepolia' }).waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('link', { name: 'All markets' }).click();
    await page.getByRole('heading', { name: 'Will the night market open?', exact: true }).waitFor();
    login = false; const before = sessionReads; await page.goto('https://flurbo.singu.online/markets'); await page.waitForURL('**/login');
    assert.ok(sessionReads > before);
    assert.deepEqual(namespaceReads, []);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
