import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { encodeFunctionData, parseAbi } from 'viem';

const skip = !process.env.FLURBO_TEST_PLAYWRIGHT;
const ORIGIN = 'https://flurbo.singu.online';
const asset = async (route: any, path: string) => {
  const relative = path.startsWith('/assets/') ? path.slice(1) : 'index.html';
  return route.fulfill({ body: await readFile(new URL('../dist/' + relative, import.meta.url)), contentType: relative.endsWith('.js') ? 'text/javascript' : relative.endsWith('.css') ? 'text/css' : relative.endsWith('.woff2') ? 'font/woff2' : 'text/html' });
};
const inView = async (page: any, locator: any) => {
  const box = await locator.boundingBox(), size = page.viewportSize();
  return !!box && box.y >= 0 && box.x >= 0 && box.y + box.height <= size.height && box.x + box.width <= size.width;
};

async function hybridPage(browser: any, viewport: { width: number; height: number }) {
  const pool = '0x' + '44'.repeat(20), owner = '0x' + '11'.repeat(20), account = '0x' + '22'.repeat(20), id = `${pool}-0`, now = Math.floor(Date.now() / 1000);
  const market = { id, pool, poolTitle: 'Source pool', eventIndex: 0, question: 'Will the test block contain a transaction?', route: 'mechanical', closesAt: now + 7200, observationEndsAt: now + 10800 };
  let allowance = '0';
  const page = await browser.newPage({ viewport });
  const errors: string[] = [];
  page.on('pageerror', (error: Error) => errors.push(error.message));
  await page.addInitScript((wallet: string) => {
    let release: (() => void) | null = null;
    (window as any).releaseWallet = () => release?.();
    (window as any).ethereum = { isMetaMask: true, on: () => {}, removeListener: () => {}, request: async ({ method }: any) => {
      if (method === 'eth_chainId') return '0x279f';
      if (method === 'eth_requestAccounts') { sessionStorage.setItem('hybrid.permission', '1'); return [wallet]; }
      if (method === 'eth_accounts') return sessionStorage.getItem('hybrid.permission') ? [wallet] : [];
      if (method === 'eth_sendTransaction') {
        if (sessionStorage.getItem('hybrid.hold')) await new Promise<void>(resolve => { release = resolve; });
        const count = Number(sessionStorage.getItem('hybrid.sends') || '0') + 1;
        sessionStorage.setItem('hybrid.sends', String(count));
        return '0x' + count.toString(16).padStart(64, '0');
      }
      if (method === 'eth_getTransactionReceipt') return null;
      throw Error(`Unexpected wallet method: ${method}`);
    } };
  }, owner);
  await page.route('**/*', async (route: any) => {
    const url = new URL(route.request().url()), path = url.pathname;
    if (path === '/api/auth/session') return route.fulfill({ json: { session: { address: account, method: 'passkey', expiresAt: Date.now() + 3600_000 } } });
    if (path === '/api/account/access') return route.fulfill({ json: { approved: true, testingTools: false } });
    if (path === '/api/account/wallets' || path === '/api/account/portfolio-sources') return route.fulfill({ json: { account, wallets: [owner.toLowerCase()], agentWallets: [] } });
    if (path === '/api/market-directory') return route.fulfill({ json: { schema: 'flurbo.market-directory.v1', markets: [], oracleMarkets: [], hybridMarkets: [market] } });
    if (path === `/api/hybrid/${id}/market`) return route.fulfill({ json: { prices: { yes: '500000', no: '500000' }, marketNow: now, funded: true, resolved: false } });
    if (path === `/api/hybrid/${id}/price-history`) return route.fulfill({ json: { pool, sampling: 'current', points: [{ timestamp: now, blockNumber: '1', prices: [{ event: 0, yes: '500000', no: '500000' }] }] } });
    if (path === `/api/hybrid/${id}`) return route.fulfill({ json: { ...market, schema: 'flurbo.hybrid-snapshot.v1', resolver: pool, eventHash: '0x' + '33'.repeat(32), rulesHash: '0x' + '55'.repeat(32), adapter: pool,
      source: { adapter: 'evm-rpc.v1', publisher: 'Test RPC' }, marketNow: now, funded: true, resolved: false, delivered: false, assertionDeadline: now + 14400, reportDeadline: now + 86400, bondAtoms: '1000000',
      phase: 0, proposal: 0, counter: 0, result: 0, challengeUntil: 0, arbitrationUntil: 0, requestId: '0x' + '00'.repeat(32), sourceCaseId: '0x' + '00'.repeat(32), proposalEvidenceURI: null, reality: null,
      user: url.searchParams.has('wallet') ? { wallet: owner, noShares: '0', yesShares: '0', cashAtoms: '10000000', allowanceAtoms: allowance, bondAllowanceAtoms: '0', bondCreditsAtoms: '0' } : null } });
    if (path === `/api/hybrid/${id}/action`) {
      const { action, input } = route.request().postDataJSON();
      const quantity = BigInt(input?.quantity || 0), cost = quantity / 2n, maximum = cost + (cost + 199n) / 200n;
      if (action === 'quote') return route.fulfill({ json: { action, buyAtoms: cost.toString(), maxCostAtoms: maximum.toString(), sellAtoms: null, minProceedsAtoms: null, cashAtoms: '10000000', allowanceAtoms: allowance, holdingsAtoms: '0' } });
      const data = action === 'buy' ? encodeFunctionData({ abi: parseAbi(['function buy(uint32,uint256,uint128,uint128,uint256) returns (uint128)']), functionName: 'buy', args: [1, 2n, quantity, maximum, BigInt(now + 120)] }) : '0x1234';
      return route.fulfill({ json: { action, amountAtoms: maximum.toString(), maxCostAtoms: maximum.toString(), reason: `${action} shares`, transaction: { chainId: 10143, from: owner, to: pool, data, value: '0x0' } } });
    }
    if (path.startsWith('/api/')) return route.fulfill({ status: 503, json: { error: 'Unavailable fixture' } });
    return asset(route, path);
  });
  await page.goto(`${ORIGIN}/markets/hybrid/${pool}/0`);
  const ticket = page.getByRole('region', { name: 'Trade this market' });
  await ticket.getByRole('button', { name: 'Connect MetaMask' }).click();
  await ticket.getByRole('button', { name: 'Review AUSD approval' }).waitFor();
  return { page, ticket, errors, pool };
}

test('wallet confirmations open in a sheet with the confirm button in view', { skip }, async () => {
  const { chromium } = await import(pathToFileURL(process.env.FLURBO_TEST_PLAYWRIGHT!).href);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.FLURBO_TEST_BROWSER });
  try {
    for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 664 }]) {
      const { page, ticket, errors } = await hybridPage(browser, viewport);
      await ticket.getByRole('button', { name: 'Review AUSD approval' }).click();
      const sheet = page.getByRole('dialog', { name: 'Step 1 of 2: allow this payment' });
      await sheet.waitFor();
      const allow = sheet.getByRole('button', { name: 'Allow payment', exact: true });
      await page.waitForTimeout(400);
      assert.ok(await inView(page, allow), `${viewport.width}x${viewport.height}: confirm button out of view`);
      assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Step 1 of 2: allow this payment', 'focus starts on the sheet heading');
      await page.keyboard.press('Enter');
      assert.equal(await page.evaluate(() => sessionStorage.getItem('hybrid.sends')), null, 'Enter on the heading never confirms');
      await page.keyboard.press('Escape');
      await sheet.waitFor({ state: 'hidden' });
      await ticket.getByRole('button', { name: 'Review AUSD approval' }).waitFor();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally { await browser.close(); }
});

test('a sheet waiting for the wallet cannot be dismissed, and a sent transaction can be minimized to the dock', { skip }, async () => {
  const { chromium } = await import(pathToFileURL(process.env.FLURBO_TEST_PLAYWRIGHT!).href);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.FLURBO_TEST_BROWSER });
  try {
    const { page, ticket, errors, pool } = await hybridPage(browser, { width: 1280, height: 800 });
    await page.evaluate(() => sessionStorage.setItem('hybrid.hold', '1'));
    await ticket.getByRole('button', { name: 'Review AUSD approval' }).click();
    await page.getByRole('dialog', { name: 'Step 1 of 2: allow this payment' }).getByRole('button', { name: 'Allow payment', exact: true }).click();
    const waiting = page.getByRole('dialog', { name: 'Waiting for confirmation' });
    await waiting.waitFor();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    assert.ok(await waiting.isVisible(), 'Escape is ignored while the wallet has not returned a hash');
    assert.equal(await waiting.getByRole('button', { name: /Hide and keep tracking|Cancel review/ }).count(), 0);
    await page.evaluate(() => (window as any).releaseWallet());
    await waiting.getByRole('button', { name: 'Hide and keep tracking' }).click();
    await waiting.waitFor({ state: 'hidden' });
    const dock = page.getByRole('complementary', { name: 'Pending transaction status' });
    await dock.getByText('1 transaction pending').waitFor();
    await page.getByRole('link', { name: 'Portfolio', exact: true }).first().click();
    await page.waitForURL('**/portfolio');
    await dock.waitFor();
    await dock.getByRole('link', { name: 'View' }).click();
    await page.waitForURL(url => new URL(url).pathname === `/markets/hybrid/${pool}/0`);
    await page.getByRole('dialog', { name: 'Waiting for confirmation' }).waitFor();
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
