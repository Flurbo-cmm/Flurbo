import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { encodeFunctionData, parseAbi } from 'viem';
import { owner } from './pool-fixture.ts';

// Section 12.2: what brings a member back. A watchlist that survives reload, the change since their last visit,
// one flash when a price moves, and a way to hear about settlement after buying.
const skip = !process.env.FLURBO_TEST_PLAYWRIGHT;
const ORIGIN = 'https://flurbo.singu.online';
const asset = async (route: any, path: string) => {
  const relative = path.startsWith('/assets/') ? path.slice(1) : 'index.html';
  return route.fulfill({ body: await readFile(new URL('../dist/' + relative, import.meta.url)), contentType: relative.endsWith('.js') ? 'text/javascript' : relative.endsWith('.css') ? 'text/css' : relative.endsWith('.woff2') ? 'font/woff2' : 'text/html' });
};
async function launch() {
  const { chromium } = await import(pathToFileURL(process.env.FLURBO_TEST_PLAYWRIGHT!).href);
  return chromium.launch({ headless: true, executablePath: process.env.FLURBO_TEST_BROWSER });
}

test('the board keeps a watchlist, shows the change since the last visit and flashes a moved price once', { skip }, async () => {
  const browser = await launch(), pool = '0x' + '22'.repeat(20), closesAt = Math.floor(Date.now() / 1000) + 86400;
  const markets = [0, 1, 2, 3].map(eventIndex => ({ id: `${pool}-${eventIndex}`, pool, poolTitle: 'Practice', eventIndex, question: `Test event ${eventIndex + 1}`,
    route: 'mechanical', closesAt, observationEndsAt: closesAt + 3600 }));
  const key = `hybrid:${markets[0].id}`;
  let bump = 0n;
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }), errors: string[] = [];
    page.on('pageerror', (error: Error) => errors.push(error.message));
    await page.route('**/*', async (route: any) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/account/access') return route.fulfill({ json: { approved: true, testingTools: false } });
      if (path === '/api/auth/session') return route.fulfill({ json: { session: { address: owner, method: 'passkey', expiresAt: Date.now() + 3600000 } } });
      if (path === '/api/market-directory') return route.fulfill({ json: { schema: 'flurbo.market-directory.v1', markets: [], oracleMarkets: [], hybridMarkets: markets } });
      const market = markets.find(m => path === `/api/hybrid/${m.id}/market`);
      if (market) return route.fulfill({ json: { schema: 'flurbo.hybrid-market.v1', id: market.id, pool, marketNow: Math.floor(Date.now() / 1000), funded: true, resolved: false,
        prices: { yes: String(250_000n + (market.eventIndex === 0 ? bump : 0n)), no: '250000' } } });
      if (path.startsWith('/api/')) return route.fulfill({ status: 503, json: { error: 'Unused fixture endpoint' } });
      return asset(route, path);
    });
    // A visit ten minutes ago saw the first question at 0.100 Yes.
    await page.addInitScript(({ account, key }: { account: string; key: string }) => {
      if (sessionStorage.getItem('seeded')) return;
      sessionStorage.setItem('seeded', '1');
      localStorage.setItem('flurbo.seen.v1:' + account.toLowerCase(), JSON.stringify({ savedAt: Date.now() - 10 * 60_000, prices: { [key]: { yes: '100000', no: '900000' } } }));
    }, { account: owner, key });
    await page.goto(ORIGIN + '/markets');
    const first = page.locator(`.market-card[data-key="${key}"]`);
    await first.waitFor();
    const delta = first.locator('.delta');
    await delta.waitFor();
    assert.match(await delta.innerText(), /[+-]\d\.\d{3}/, 'the tile shows a signed change since the last visit');

    await first.getByRole('button', { name: 'Add to watchlist' }).click();
    assert.equal(await first.getByRole('button', { name: 'Remove from watchlist' }).getAttribute('aria-pressed'), 'true');
    await page.reload();
    await first.getByRole('button', { name: 'Remove from watchlist' }).waitFor();
    const categories = page.getByRole('navigation', { name: 'Market categories' });
    await categories.getByRole('link', { name: /Watchlist/ }).click();
    await page.waitForURL(url => new URL(url).searchParams.get('category') === 'watchlist');
    assert.equal(await page.locator('.market-card').count(), 1, 'the Watchlist category holds the watched market');
    await categories.getByRole('link', { name: /^All/ }).click();
    await first.waitFor();

    const yes = first.locator('.tile-prices a').first();
    assert.equal(await yes.locator('.price-flash-bar').count(), 0);
    bump = 20000n;
    await page.getByRole('button', { name: /Refresh prices/ }).click();
    await yes.locator('.price-flash-bar').waitFor({ state: 'attached' });
    await yes.locator('.price-flash-bar').evaluate((bar: HTMLElement) => { bar.dataset.marked = '1'; });
    await page.getByRole('button', { name: /Refresh prices/ }).click();
    await page.getByRole('button', { name: /Refresh prices/ }).waitFor();
    await page.waitForFunction(() => !document.querySelector('.board-refresh')?.hasAttribute('disabled'));
    assert.equal(await yes.locator('.price-flash-bar').count(), 1, 'an unchanged price does not flash again');
    assert.equal(await yes.locator('.price-flash-bar').getAttribute('data-marked'), '1');
    assert.equal(await first.locator('.tile-prices a').nth(1).locator('.price-flash-bar').count(), 0, 'only the moved price flashes');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('a completed purchase offers an email notice when the market settles', { skip }, async () => {
  const browser = await launch();
  const pool = '0x' + '44'.repeat(20), wallet = '0x' + '11'.repeat(20), account = '0x' + '22'.repeat(20), id = `${pool}-0`, now = Math.floor(Date.now() / 1000);
  const market = { id, pool, poolTitle: 'Source pool', eventIndex: 0, question: 'Will the test block contain a transaction?', route: 'mechanical', closesAt: now + 7200, observationEndsAt: now + 10800 };
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } }), errors: string[] = [];
    page.on('pageerror', (error: Error) => errors.push(error.message));
    await page.addInitScript((owner: string) => {
      (window as any).ethereum = { isMetaMask: true, on: () => {}, removeListener: () => {}, request: async ({ method }: any) => {
        if (method === 'eth_chainId') return '0x279f';
        if (method === 'eth_requestAccounts') { sessionStorage.setItem('granted', '1'); return [owner]; }
        if (method === 'eth_accounts') return sessionStorage.getItem('granted') ? [owner] : [];
        if (method === 'eth_sendTransaction') return '0x' + '7'.repeat(64);
        if (method === 'eth_getTransactionReceipt') return { status: '0x1' };
        throw Error(`Unexpected wallet method: ${method}`);
      } };
    }, wallet);
    await page.route('**/*', async (route: any) => {
      const url = new URL(route.request().url()), path = url.pathname;
      if (path === '/api/auth/session') return route.fulfill({ json: { session: { address: account, method: 'passkey', expiresAt: Date.now() + 3600_000 } } });
      if (path === '/api/account/access') return route.fulfill({ json: { approved: true, testingTools: false } });
      if (path === '/api/account/wallets' || path === '/api/account/portfolio-sources') return route.fulfill({ json: { account, wallets: [wallet], agentWallets: [] } });
      if (path === '/api/market-directory') return route.fulfill({ json: { schema: 'flurbo.market-directory.v1', markets: [], oracleMarkets: [], hybridMarkets: [market] } });
      if (path === `/api/hybrid/${id}/market`) return route.fulfill({ json: { prices: { yes: '500000', no: '500000' }, marketNow: now, funded: true, resolved: false } });
      if (path === `/api/hybrid/${id}/price-history`) return route.fulfill({ json: { pool, sampling: 'current', points: [] } });
      if (path === `/api/hybrid/${id}`) return route.fulfill({ json: { ...market, schema: 'flurbo.hybrid-snapshot.v1', resolver: pool, eventHash: '0x' + '33'.repeat(32), rulesHash: '0x' + '55'.repeat(32), adapter: pool,
        source: { adapter: 'evm-rpc.v1', publisher: 'Test RPC' }, marketNow: now, funded: true, resolved: false, delivered: false, assertionDeadline: now + 14400, reportDeadline: now + 86400, bondAtoms: '1000000',
        phase: 0, proposal: 0, counter: 0, result: 0, challengeUntil: 0, arbitrationUntil: 0, requestId: '0x' + '00'.repeat(32), sourceCaseId: '0x' + '00'.repeat(32), proposalEvidenceURI: null, reality: null,
        user: url.searchParams.has('wallet') ? { wallet, noShares: '0', yesShares: '0', cashAtoms: '10000000', allowanceAtoms: '100000000', bondAllowanceAtoms: '0', bondCreditsAtoms: '0' } : null } });
      if (path === `/api/hybrid/${id}/action`) {
        const { action, input } = route.request().postDataJSON();
        const quantity = BigInt(input?.quantity || 0), cost = quantity / 2n, maximum = cost + (cost + 199n) / 200n;
        if (action === 'quote') return route.fulfill({ json: { action, buyAtoms: cost.toString(), maxCostAtoms: maximum.toString(), sellAtoms: null, minProceedsAtoms: null, cashAtoms: '10000000', allowanceAtoms: '100000000', holdingsAtoms: '0' } });
        const data = encodeFunctionData({ abi: parseAbi(['function buy(uint32,uint256,uint128,uint128,uint256) returns (uint128)']), functionName: 'buy', args: [1, 2n, quantity, maximum, BigInt(now + 120)] });
        return route.fulfill({ json: { action, amountAtoms: maximum.toString(), maxCostAtoms: maximum.toString(), reason: `${action} shares`, transaction: { chainId: 10143, from: wallet, to: pool, data, value: '0x0' } } });
      }
      if (path.startsWith('/api/')) return route.fulfill({ status: 503, json: { error: 'Unavailable fixture' } });
      return asset(route, path);
    });
    await page.goto(`${ORIGIN}/markets/hybrid/${pool}/0`);
    const ticket = page.getByRole('region', { name: 'Trade this market' });
    await ticket.getByRole('button', { name: 'Connect MetaMask' }).click();
    const answer = ticket.getByRole('radiogroup', { name: 'Your answer' });
    await page.keyboard.press('n');
    await page.waitForFunction(() => document.querySelector('[role="radio"][data-value="no"]')?.getAttribute('aria-checked') === 'true');
    await page.keyboard.press('y');
    await page.waitForFunction(() => document.querySelector('[role="radio"][data-value="yes"]')?.getAttribute('aria-checked') === 'true');
    assert.equal(await answer.getByRole('radio', { name: 'Yes', exact: true }).getAttribute('aria-checked'), 'true', 'market keys choose the answer');
    await ticket.getByRole('button', { name: 'Review purchase' }).click();
    await ticket.getByRole('button', { name: /^Buy \d+ shares?$/ }).click();
    await ticket.getByRole('heading', { name: 'Purchase complete' }).waitFor();
    const notice = page.getByRole('link', { name: 'Email me when this settles' });
    assert.equal(await notice.getAttribute('href'), '/access#notices');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
