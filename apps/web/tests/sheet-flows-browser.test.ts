import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { pilotFixture, owner } from './pilot-fixture.ts';
import { setup, alice, origin } from './agent-fixture.ts';
import { TESTNET } from '../server/network.mjs';

// Section 8.4.3: the remaining wallet confirmations open in the transaction sheet.
const skip = !process.env.FLURBO_TEST_PLAYWRIGHT;
const asset = async (route: any, path: string) => {
  const relative = path.startsWith('/assets/') ? path.slice(1) : 'index.html';
  return route.fulfill({ body: await readFile(new URL('../dist/' + relative, import.meta.url)), contentType: relative.endsWith('.js') ? 'text/javascript' : relative.endsWith('.css') ? 'text/css' : relative.endsWith('.woff2') ? 'font/woff2' : 'text/html' });
};
const inView = async (page: any, locator: any) => {
  const box = await locator.boundingBox(), size = page.viewportSize();
  return !!box && box.y >= 0 && box.y + box.height <= size.height;
};
async function launch() {
  const { chromium } = await import(pathToFileURL(process.env.FLURBO_TEST_PLAYWRIGHT!).href);
  return chromium.launch({ headless: true, executablePath: process.env.FLURBO_TEST_BROWSER });
}
// MetaMask announced over EIP-6963 on Monad testnet. Signing and sending wait until the test releases them.
function wallet({ owner, hash }: { owner: string; hash: string }) {
  const held: Record<string, () => void> = {};
  // The page may show "confirm in MetaMask" a few awaits before it sends the request, so release waits for the request.
  (window as any).release = async (method: string) => {
    for (let waited = 0; !held[method] && waited < 20_000; waited += 20) await new Promise(done => setTimeout(done, 20));
    if (!held[method]) throw Error(`The page never asked the wallet for ${method}`);
    held[method]();
  };
  const hold = (method: string, value: unknown) => new Promise(resolve => { held[method] = () => resolve(value); });
  const metamask = { on: () => {}, removeListener: () => {}, request: async ({ method }: any) => {
    if (method === 'eth_chainId') return '0x279f';
    if (['eth_accounts', 'eth_requestAccounts'].includes(method)) return [owner];
    if (method === 'wallet_requestPermissions') return [];
    if (method === 'personal_sign') return hold(method, '0x' + '11'.repeat(65));
    if (method === 'eth_sendTransaction') return hold(method, hash);
    if (method === 'eth_getBlockByNumber') return { hash, number: '0x64' };
    if (method === 'eth_call') return '0x';
    if (method === 'eth_gasPrice') return '0x3b9aca00';
    if (method === 'eth_estimateGas') return '0x186a0';
    throw Error(method);
  } };
  (window as any).ethereum = { ...metamask, isMetaMask: true };
  window.addEventListener('eip6963:requestProvider', () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: { name: 'MetaMask', rdns: 'io.metamask' }, provider: metamask } })));
}

test('linking a wallet and requesting test AUSD wait in sheets that cannot be dismissed while the wallet is open', { skip }, async () => {
  const browser = await launch(), login = '0x' + '99'.repeat(20), f = pilotFixture(Math.floor(Date.now() / 1000), 4), txHash = '0x' + 'ab'.repeat(32);
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } }), errors: string[] = [];
    page.on('pageerror', (error: Error) => errors.push(error.message));
    await page.addInitScript(wallet, { owner, hash: txHash });
    let linked = false, receipt: any = null, receiptReads = 0;
    await page.route('**/*', async (route: any) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/network') return route.fulfill({ json: { ...TESTNET, flurboFaucet: true } });
      if (path === '/api/auth/session') return route.fulfill({ json: { session: { address: login, method: 'passkey', expiresAt: Date.now() + 3600_000 } } });
      if (path === '/api/account/access') return route.fulfill({ json: { approved: true, testingTools: false } });
      if (path === '/api/account/wallets') return route.fulfill({ json: { account: login, wallets: linked ? [owner] : [] } });
      if (path === '/api/account/wallets/challenge') return route.fulfill({ json: { id: 'proof', message: 'Link this MetaMask wallet to your Flurbo account; no transaction.' } });
      if (path === '/api/account/wallets/verify') { linked = true; return route.fulfill({ json: { account: login, wallets: [owner] } }); }
      if (path === '/api/market-directory') return route.fulfill({ json: { schema: 'flurbo.market-directory.v1', markets: [{ namespace: 'practice-' + f.manifest.pool.slice(2), label: 'Practice', pool: f.manifest.pool, closesAt: f.manifest.publication.draft.closesAt }] } });
      if (path === '/api/rpc') {
        const { method, params } = route.request().postDataJSON();
        if (method === 'eth_getTransactionReceipt') receiptReads++;
        let result: any = method === 'eth_getBlockByNumber' ? { hash: txHash, number: '0x64' } : method === 'eth_getBalance' ? '0xde0b6b3a7640000' : method === 'eth_getTransactionReceipt' ? receipt : '0x0';
        if (method === 'eth_call' && params[0].data.startsWith('0x70a08231')) result = params[0].data.endsWith(TESTNET.faucet.slice(2)) ? '0x3b9aca00' : '0x0';
        return route.fulfill({ json: { result } });
      }
      if (path.startsWith('/api/')) return route.fulfill({ status: 503, json: { error: 'Unavailable fixture' } });
      return asset(route, path);
    });
    await page.goto(origin + '/fund');
    await page.getByRole('button', { name: /^(Connect MetaMask|Link selected wallet)$/ }).click();
    const link = page.getByRole('dialog', { name: 'Link this wallet' });
    await link.waitFor();
    assert.match(await link.innerText(), /not a transaction/i);
    assert.equal(await link.getByRole('button').count(), 0, 'a signature request cannot be dismissed from the page');
    await page.keyboard.press('Escape');
    assert.equal(await link.isVisible(), true, 'Escape does not hide a sheet waiting for the wallet');
    await page.evaluate(() => (window as any).release('personal_sign'));
    await link.waitFor({ state: 'hidden' });

    const request = page.getByRole('button', { name: 'Request test AUSD', exact: true });
    await page.waitForFunction(() => { const b = [...document.querySelectorAll('button')].find(e => e.textContent === 'Request test AUSD'); return !!b && !(b as HTMLButtonElement).disabled; });
    await request.click();
    const sheet = page.getByRole('dialog', { name: 'Get test AUSD' });
    await sheet.getByText('Confirm the test AUSD request in MetaMask.').waitFor();
    assert.equal(await page.getByText('Confirm the test AUSD request in MetaMask.').count(), 1, 'the status shows once, in the sheet');
    assert.equal(await sheet.getByRole('button').count(), 0);
    await page.evaluate(() => (window as any).release('eth_sendTransaction'));
    const hide = sheet.getByRole('button', { name: 'Hide and keep tracking' });
    await hide.waitFor();
    assert.ok(await inView(page, hide));
    await hide.click();
    await sheet.waitFor({ state: 'hidden' });
    await page.getByRole('link', { name: 'View faucet transaction' }).waitFor();
    // The page checks the receipt by itself as soon as the request is pending. Let that check find nothing first, so the
    // manual check below is the one that sees the receipt (otherwise the automatic check can win and the button goes away).
    while (receiptReads === 0) await new Promise(done => setTimeout(done, 20));
    receipt = { transactionHash: txHash, to: TESTNET.faucet, from: owner, status: '0x1' };
    await page.getByRole('button', { name: 'Check status', exact: true }).click();
    await page.getByText('Test AUSD request confirmed. You can return to the markets.').waitFor();
    assert.equal(await page.getByText('Test AUSD request confirmed. You can return to the markets.').count(), 1);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('allowing live agent trades confirms in a sheet that restates the limits and changes nothing until confirmed', { skip }, async () => {
  const browser = await launch(), s = setup({ at: Math.floor(Date.now() / 1000) }), policies: any[] = [];
  try {
    for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 664 }]) {
      const page = await browser.newPage({ viewport }), errors: string[] = [];
      page.on('pageerror', (error: Error) => errors.push(error.message));
      await page.route('**/*', async (route: any) => {
        const p = new URL(route.request().url()).pathname, method = route.request().method();
        if (p === '/api/auth/session') return route.fulfill({ json: { session: { address: alice, method: 'passkey', expiresAt: Date.now() + 3600000 } } });
        if (p === '/api/account/access') return route.fulfill({ json: { approved: true } });
        if (p === '/api/market-directory') return route.fulfill({ json: { schema: 'flurbo.market-directory.v1', markets: [{ namespace: 'pilot', label: 'Open fixture', pool: s.f.manifest.pool, closesAt: s.f.manifest.publication.draft.closesAt }] } });
        if (p === '/api/pilot/markets') return route.fulfill({ json: await s.f.service.markets() });
        if (p === '/api/agents' || p.startsWith('/api/agents/')) {
          const body = method === 'POST' ? route.request().postDataJSON() : undefined;
          if (p.endsWith('/runtime-policy') && method === 'POST') policies.push(body);
          const result = await s.call(alice, method, p, body); return route.fulfill({ status: result.status, json: result.body });
        }
        if (p.startsWith('/api/')) return route.fulfill({ status: 503, json: { error: 'Unused fixture' } });
        return asset(route, p);
      });
      await page.goto(origin + '/agents');
      await page.waitForFunction(() => { const root = document.querySelector('.app-root') as HTMLElement | null; return !!root && !root.inert && !document.querySelector('.contour-loader') && !!document.querySelector('#register-agent input[type=checkbox]'); });
      const form = page.getByRole('form', { name: 'Register an agent' });
      await form.getByLabel('Name', { exact: true }).fill('Sheet agent ' + viewport.width); await form.getByRole('button', { name: 'Register agent', exact: true }).click();
      await page.waitForURL(/\/agents\/[0-9a-f-]{36}$/, { timeout: 15000 });
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      const before = policies.length;
      await page.getByRole('button', { name: 'Allow live testnet trades' }).click();
      const sheet = page.getByRole('dialog', { name: 'Allow this agent to send live testnet trades?' });
      await sheet.waitFor();
      const group = sheet.getByRole('group', { name: 'Confirm live testnet trades' });
      assert.match(await group.innerText(), /2 test AUSD per trade/);
      const confirm = group.getByRole('button', { name: 'Confirm live testnet trades' });
      await page.waitForTimeout(400);
      assert.ok(await inView(page, confirm), `${viewport.width}: confirm button out of view`);
      await page.keyboard.press('Escape');
      await sheet.waitFor({ state: 'hidden' });
      assert.equal(policies.length, before, 'closing the sheet changes nothing');
      await page.getByRole('button', { name: 'Allow live testnet trades' }).click();
      await confirm.click();
      await page.getByRole('button', { name: 'Stop allowing live trades' }).waitFor();
      await sheet.waitFor({ state: 'hidden' });
      assert.deepEqual(policies.slice(before), [{ liveEnabled: true }]);
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally { await browser.close(); }
});
