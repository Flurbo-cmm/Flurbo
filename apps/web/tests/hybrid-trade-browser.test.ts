import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

test('hybrid market simulates quote, approval, reload, purchase, and confirmation in the trade ticket',
  { skip: !process.env.FLURBO_TEST_PLAYWRIGHT }, async () => {
    const { chromium } = await import(pathToFileURL(process.env.FLURBO_TEST_PLAYWRIGHT!).href);
    const browser = await chromium.launch({ headless: true, executablePath: process.env.FLURBO_TEST_BROWSER });
    const pool = '0x' + '44'.repeat(20), owner = '0x' + '11'.repeat(20);
    const account = '0x' + '22'.repeat(20), id = `${pool}-0`, now = Math.floor(Date.now() / 1000);
    const market = { id, pool, poolTitle: 'Source pool', eventIndex: 0,
      question: 'Will the test block contain a transaction?', route: 'mechanical',
      closesAt: now + 7200, observationEndsAt: now + 10800 };
    let allowance = '0';
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
            if (sessionStorage.getItem('hybrid.reject')) {
              sessionStorage.removeItem('hybrid.reject');
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
        if (path === '/api/auth/session') return route.fulfill({ json: { session: {
          address: account, method: 'passkey', expiresAt: Date.now() + 3600_000 } } });
        if (path === '/api/account/access') return route.fulfill({ json: { approved: true, testingTools: false } });
        if (path === '/api/account/wallets') return route.fulfill({ json: { account, wallets: [owner.toLowerCase()] } });
        if (path === '/api/account/portfolio-sources') return route.fulfill({ json: {
          account, wallets: [owner.toLowerCase()], agentWallets: [] } });
        if (path === '/api/market-directory') return route.fulfill({ json: {
          schema: 'flurbo.market-directory.v1', markets: [], oracleMarkets: [], hybridMarkets: [market] } });
        if (path === `/api/hybrid/${id}/market`) return route.fulfill({ json: {
          prices: { yes: '500000', no: '500000' }, marketNow: now, funded: true, resolved: false } });
        if (path === `/api/hybrid/${id}/price-history`) return route.fulfill({ json: {
          pool, sampling: 'current', points: [{ timestamp: now, blockNumber: '1',
            prices: [{ event: 0, yes: '500000', no: '500000' }] }] } });
        if (path === `/api/hybrid/${id}`) return route.fulfill({ json: { ...market,
          schema: 'flurbo.hybrid-snapshot.v1', resolver: pool, eventHash: '0x' + '33'.repeat(32),
          rulesHash: '0x' + '55'.repeat(32), adapter: pool, source: { adapter: 'evm-rpc.v1', publisher: 'Test RPC' },
          marketNow: now, funded: true, resolved: false, delivered: false,
          assertionDeadline: now + 14400, reportDeadline: now + 86400, bondAtoms: '1000000',
          phase: 0, proposal: 0, counter: 0, result: 0, challengeUntil: 0, arbitrationUntil: 0,
          requestId: '0x' + '00'.repeat(32), sourceCaseId: '0x' + '00'.repeat(32),
          proposalEvidenceURI: null, reality: null,
          user: url.searchParams.has('wallet') ? { wallet: owner, noShares: '0', yesShares: '0',
            cashAtoms: '10000000', allowanceAtoms: allowance, bondAllowanceAtoms: '0', bondCreditsAtoms: '0' } : null } });
        if (path === `/api/hybrid/${id}/action`) {
          const { action, input } = route.request().postDataJSON();
          const quantity = BigInt(input?.quantity || 0);
          const cost = quantity === 5_000_000n ? 2_800_000n : quantity / 2n;
          const maximum = cost + (cost + 199n) / 200n;
          if (action === 'quote') return route.fulfill({ json: { action,
            buyAtoms: cost.toString(), maxCostAtoms: maximum.toString(), sellAtoms: null,
            minProceedsAtoms: null, cashAtoms: '10000000', allowanceAtoms: allowance, holdingsAtoms: '0' } });
          if (action === 'approve') allowance = maximum.toString();
          return route.fulfill({ json: { action, amountAtoms: maximum.toString(),
            maxCostAtoms: maximum.toString(), reason: `${action} five shares`, transaction: {
              chainId: 10143, from: owner, to: pool, data: '0x1234', value: '0x0' } } });
        }
        if (path.startsWith('/api/')) return route.fulfill({ status: 503, json: { error: 'Unavailable fixture' } });
        const relative = path.startsWith('/assets/') ? path.slice(1) : 'index.html';
        return route.fulfill({ body: await readFile(new URL('../dist/' + relative, import.meta.url)),
          contentType: relative.endsWith('.js') ? 'text/javascript' : relative.endsWith('.css')
            ? 'text/css' : relative.endsWith('.woff2') ? 'font/woff2' : 'text/html' });
      });
      await page.goto(`https://flurbo.singu.online/markets/hybrid/${pool}/0`);
      const ticket = page.getByRole('region', { name: 'Trade this market' });
      await ticket.getByRole('button', { name: 'Connect MetaMask' }).click();
      await ticket.getByLabel('Shares', { exact: true }).fill('5');
      await ticket.getByText('2.8 test AUSD', { exact: false }).waitFor();
      await ticket.getByRole('button', { name: 'Review AUSD approval' }).click();
      await ticket.getByRole('heading', { name: 'Step 1 of 2: allow this payment' }).waitFor();
      assert.equal(await page.getByRole('region', { name: 'Transaction review' }).count(),1);
      await page.evaluate(() => sessionStorage.setItem('hybrid.reject', '1'));
      await ticket.getByRole('button', { name: 'Allow payment', exact: true }).click();
      await ticket.getByRole('alert').getByText('Transaction cancelled in MetaMask.').waitFor();
      assert.equal(await page.evaluate(() => sessionStorage.getItem('flurbo.hybrid.pending.v1')), null);
      await ticket.getByRole('button', { name: 'Allow payment', exact: true }).click();
      await ticket.getByRole('heading', { name: 'Waiting for confirmation' }).waitFor();
      await page.reload();
      await ticket.getByLabel('Shares', { exact: true }).waitFor({ state: 'hidden' });
      await page.evaluate(() => sessionStorage.setItem('hybrid.receiptReady', '1'));
      await ticket.getByRole('button', { name: 'Switch wallet' }).waitFor();
      await ticket.getByRole('heading', { name: 'Review your purchase' }).waitFor();
      assert.equal(await ticket.getByLabel('Shares', { exact: true }).inputValue(), '5');
      if (process.env.FLURBO_TEST_SCREENSHOT)
        await page.screenshot({ path: process.env.FLURBO_TEST_SCREENSHOT, fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.equal(await page.evaluate(() => sessionStorage.getItem('hybrid.sends')), '1');
      await ticket.getByRole('button', { name: 'Buy 5 shares' }).click();
      await ticket.getByRole('heading', { name: 'Purchase complete' }).waitFor();
      assert.equal(await page.evaluate(() => sessionStorage.getItem('hybrid.sends')), '2');
      assert.equal(await page.evaluate(() => sessionStorage.getItem('flurbo.hybrid.pending.v1')), null);
      await page.evaluate(() => {
        sessionStorage.setItem('hybrid.selectedWallet', '0x' + '33'.repeat(20));
        (window as any).walletEvent('accountsChanged');
      });
      await ticket.getByRole('button', { name: 'Link selected wallet' }).waitFor();
      assert.equal(await ticket.getByRole('heading', { name: 'Purchase complete' }).count(), 0);
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });

test('reality market shows the Kleros case, the juror wait and Sepolia links',
  { skip: !process.env.FLURBO_TEST_PLAYWRIGHT }, async () => {
    const { chromium } = await import(pathToFileURL(process.env.FLURBO_TEST_PLAYWRIGHT!).href);
    const browser = await chromium.launch({ headless: true, executablePath: process.env.FLURBO_TEST_BROWSER });
    const pool = '0x' + '44'.repeat(20), account = '0x' + '22'.repeat(20), id = `${pool}-0`;
    const now = Math.floor(Date.now() / 1000), zero = '0x' + '00'.repeat(32);
    const market = { id, pool, poolTitle: 'Reality pool', eventIndex: 0,
      question: 'Will the test block contain a transaction?', route: 'reality',
      closesAt: now - 7200, observationEndsAt: now - 3600 };
    const errors: string[] = [];
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      page.on('pageerror', (error: Error) => errors.push(error.message));
      await page.route('**/*', async (route: any) => {
        const url = new URL(route.request().url()), path = url.pathname;
        if (path === '/api/auth/session') return route.fulfill({ json: { session: {
          address: account, method: 'passkey', expiresAt: Date.now() + 3600_000 } } });
        if (path === '/api/account/access') return route.fulfill({ json: { approved: true, testingTools: false } });
        if (path === '/api/account/wallets') return route.fulfill({ json: { account, wallets: [] } });
        if (path === '/api/account/portfolio-sources') return route.fulfill({ json: { account, wallets: [], agentWallets: [] } });
        if (path === '/api/market-directory') return route.fulfill({ json: {
          schema: 'flurbo.market-directory.v1', markets: [], oracleMarkets: [], hybridMarkets: [market] } });
        if (path === `/api/hybrid/${id}/market`) return route.fulfill({ json: {
          prices: { yes: null, no: null }, marketNow: now, funded: true, resolved: false } });
        if (path === `/api/hybrid/${id}/price-history`) return route.fulfill({ json: {
          pool, sampling: 'current', points: [{ timestamp: now, blockNumber: '1',
            prices: [{ event: 0, yes: '500000', no: '500000' }] }] } });
        if (path === `/api/hybrid/${id}`) return route.fulfill({ json: { ...market,
          schema: 'flurbo.hybrid-snapshot.v1', resolver: pool, eventHash: '0x' + '33'.repeat(32),
          rulesHash: '0x' + '55'.repeat(32), adapter: pool, source: { kind: 'reality-sepolia' },
          marketNow: now, funded: true, resolved: false, delivered: false,
          assertionDeadline: now + 14400, reportDeadline: now + 86400, bondAtoms: '1000000',
          phase: 0, proposal: 0, counter: 0, result: 0, challengeUntil: 0, arbitrationUntil: 0,
          requestId: zero, sourceCaseId: zero, proposalEvidenceURI: null, user: null,
          ruleURI: `https://flurbopm.singu.online/api/hybrid/rules/0x${'66'.repeat(32)}`,
          automaticAnswer: { outcome: 2, evidenceURI: 'https://flurbopm.singu.online/api/pilot/evidence/0x1', observedAt: now - 3000 },
          reality: { chainId: 11155111, reality: pool, arbitrator: pool, questionId: '0x' + '77'.repeat(32),
            sourceNow: now, opensAt: now - 3600, finalizesAt: now + 600, bondWei: '100000000000000',
            nextBondWei: '200000000000000', disputeFeeWei: '10000000000000000', pendingArbitration: true,
            finalized: false, creditedEthWei: '0', answerLabel: 'Yes', historyHash: zero, disputeStatus: 1,
            disputeId: '7', court: { court: pool, disputeId: '7', period: 2, periodLabel: 'Vote',
              periodEndsAt: now + 600, rounds: 1, drawn: 1, votesNeeded: 1, votesCast: 0, ruled: false,
              currentRuling: null, appeal: null },
            links: { questionTx: null, reality: 'https://reality.eth.limo/app/#!/network/11155111/question/x',
              courtContract: `https://sepolia.etherscan.io/address/${pool}#events` } } } });
        if (path.startsWith('/api/')) return route.fulfill({ status: 503, json: { error: 'Unavailable fixture' } });
        const relative = path.startsWith('/assets/') ? path.slice(1) : 'index.html';
        return route.fulfill({ body: await readFile(new URL('../dist/' + relative, import.meta.url)),
          contentType: relative.endsWith('.js') ? 'text/javascript' : relative.endsWith('.css')
            ? 'text/css' : relative.endsWith('.woff2') ? 'font/woff2' : 'text/html' });
      });
      await page.goto(`https://flurbopm.singu.online/markets/hybrid/${pool}/0`);
      await page.getByText('Kleros case #7: Vote.', { exact: false }).first().waitFor();
      await page.getByText('Waiting for the juror vote', { exact: false }).first().waitFor();
      const href = await page.getByRole('link', { name: 'Court contract on Etherscan' }).getAttribute('href');
      assert.ok(href?.startsWith('https://sepolia.etherscan.io'));
      await page.getByText('Flurbo reader answered Yes', { exact: false }).first().waitFor();
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });
