import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { generatePrivateKey } from 'viem/accounts';
import { startLocalStack } from '../tools/local-stack.ts';
import { agentRunner, defaultConfig } from '../src/node/runner.ts';
import { localKeySigner } from '../src/node/signer.ts';
import { fixtureRetriever, fixtureForecaster } from '../src/node/research.ts';
import { MODEL_SCHEMA } from '../src/research.ts';
import { evidenceFixture } from './evidence-fixture.ts';

// The /agents dashboard in a real browser against the real local stack: set up an agent in the UI, run it
// outside the browser, then see its status and verified trades. Needs a built dashboard (npm run build in
// apps/web) and FLURBO_TEST_PLAYWRIGHT / FLURBO_TEST_BROWSER, like the web app's browser tests.
test('dashboard: register, link the wallet, issue a credential, then watch a runtime trade', { skip: !process.env.FLURBO_TEST_PLAYWRIGHT, timeout: 240_000 }, async () => {
  const { chromium } = await import(pathToFileURL(process.env.FLURBO_TEST_PLAYWRIGHT!).href);
  const stack = await startLocalStack({ rpcPort: 18845, apiPort: 19067 });
  const browser = await chromium.launch({ headless: true, executablePath: process.env.FLURBO_TEST_BROWSER });
  const dir = mkdtempSync(join(tmpdir(), 'flurbo-dash-')), errors: string[] = [];
  try {
    const cookie = await stack.signIn(generatePrivateKey());
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
    await context.addCookies([{ name: 'flurbo_session', value: cookie.split('=')[1], url: stack.apiUrl }]);
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: stack.apiUrl });
    const page = await context.newPage();
    page.on('pageerror', (e: Error) => errors.push(e.message));
    await page.goto(`${stack.apiUrl}/agents`);
    // Register: the primary flow is an agent that runs elsewhere; the assisted flow is secondary.
    // The page is usable while the agent list loads, so wait for what a person would: the loader gone, a market
    // ticked, and the name really in the box, before registering.
    const form = page.getByRole('form', { name: 'Register an agent' });
    await page.locator('.contour-loader').waitFor({ state: 'detached', timeout: 30_000 }).catch(() => {});
    await form.getByRole('checkbox', { checked: true }).first().waitFor({ timeout: 30_000 });
    const nameField = form.getByLabel('Name');
    await nameField.fill('Dashboard test agent');
    assert.equal(await nameField.inputValue(), 'Dashboard test agent');
    await form.getByRole('button', { name: 'Register agent' }).click();
    await page.waitForURL(/\/agents\/[0-9a-f-]{36}$/).catch(async (error: Error) => {
      const alert = await form.getByRole('alert').textContent({ timeout: 1_000 }).catch(() => null);
      throw new Error(`Registering did not open the agent page${alert ? `: ${alert}` : ''} (${error.message.split('\n')[0]})`);
    });
    const agentUrl = page.url();
    await page.getByRole('region', { name: 'Runtime status' }).getByText('The runtime has not connected yet').waitFor();
    await page.getByText('Closing this page does not stop the agent', { exact: false }).waitFor();
    // Link the wallet with a real ownership proof.
    await page.getByRole('navigation', { name: 'Agent sections' }).getByRole('button', { name: 'Setup', exact: true }).click();
    const key = generatePrivateKey(), signer = localKeySigner(key);
    const walletCard = page.getByRole('region', { name: 'Agent wallet' });
    await walletCard.getByLabel('Wallet address').fill(signer.address);
    await walletCard.getByRole('button', { name: 'Get ownership message' }).click();
    const message = await walletCard.locator('pre').innerText();
    assert.match(message, /^Flurbo agent wallet association\n/);
    await walletCard.getByLabel('Signature').fill(await signer.signMessage(message));
    await walletCard.getByRole('button', { name: 'Verify and associate' }).click();
    await walletCard.getByText(`Associated wallet ${signer.address}`).waitFor();
    // Issue a credential: shown once.
    const creds = page.getByRole('region', { name: 'API credentials' });
    await creds.getByRole('button', { name: 'Issue credential' }).click();
    const token = (await creds.locator('.agents-note pre').innerText()).trim();
    assert.match(token, /^fla1_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/);
    await creds.getByRole('button', { name: 'I have stored it' }).click();
    assert.equal(await creds.getByText(token).count(), 0, 'the token is not shown again');
    await page.reload();
    assert.equal(await page.getByText(token).count(), 0, 'not after a reload either');
    await page.getByRole('navigation', { name: 'Agent sections' }).getByRole('button', { name: 'Setup', exact: true }).click();
    // Every language is available with its own runner, and no setup text contains a secret. The repository is
    // private, so the card links nowhere on GitHub and says how to get the SDK source instead.
    const setup = page.getByRole('region', { name: 'Run the agent' });
    for (const [tab, runner] of [['TypeScript', 'bin/flurbo-agent.ts start'], ['Python', 'python -m flurbo_sdk start'],
      ['Rust', 'flurbo-agent-rs start'], ['C++', 'flurbo-agent-cpp start']]) {
      await setup.getByRole('tab', { name: tab, exact: true }).click();
      const text = await setup.innerText();
      assert.ok(text.includes(runner), `${tab} runner setup`);
      assert.equal(await setup.locator('a[href*="github.com"]').count(), 0, `${tab} has no repository link`);
      assert.ok(text.includes('The source is not public yet'), `${tab} explains how to get the SDK`);
      assert.ok(!text.includes('not complete yet') && !text.includes(token), `${tab} setup text`);
    }
    // Allow live trades, then run the agent outside the browser.
    await page.getByRole('navigation', { name: 'Agent sections' }).getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Allow live testnet trades' }).click();
    await page.getByRole('button', { name: 'Confirm live testnet trades', exact: true }).click();
    await page.getByText('Currently: allowed here').waitFor();
    await stack.setNativeBalance(signer.address, 10n ** 19n); await stack.mint(signer.address, 20_000_000n);
    const reply = JSON.stringify({ schema: MODEL_SCHEMA, abstain: false, abstainReason: null, events: [0, 1], statesPpm: [50_000, 50_000, 50_000, 850_000], evidenceIds: ['src-1'],
      assumptions: ['Shared release process.'], uncertainty: 'A late blocker.', explanation: 'Both release candidates are tagged together (fixture reply).' });
    const runner = agentRunner({ config: { ...defaultConfig(), api: { baseUrl: stack.apiUrl, credentialEnv: 'T' }, chain: { rpcUrl: stack.rpcUrl }, stateDir: dir, mode: 'live',
      schedule: { intervalSeconds: 30, heartbeatSeconds: 10, waitSeconds: 30 }, policy: { ...defaultConfig().policy, minSecondsBeforeClose: 600 } },
      env: { T: token }, signer, retriever: fixtureRetriever([evidenceFixture()]),
      forecaster: fixtureForecaster(() => reply, 'dashboard-fixture'), log: () => {} });
    await runner.cycle();
    // Direct URL and refresh show what the runtime reported and what Flurbo verified.
    await page.goto(agentUrl);
    await page.getByRole('region', { name: 'Runtime status' }).getByText('Runtime running', { exact: false }).waitFor();
    const verified = page.getByRole('region', { name: 'Verified trades' });
    await verified.getByText('1, paid', { exact: false }).waitFor();
    await verified.getByText('Verified on-chain').first().waitFor();
    await page.getByRole('navigation', { name: 'Agent sections' }).getByRole('button', { name: 'Activity', exact: true }).click();
    const decisions = page.getByRole('region', { name: 'Decisions' });
    await decisions.getByText('Traded').first().waitFor();
    await decisions.getByText('fixture dashboard-fixture (not AI)', { exact: false }).first().waitFor();
    await decisions.getByText('not verified by Flurbo', { exact: false }).waitFor();
    // Pause is an instruction, explained as such.
    await page.getByRole('navigation', { name: 'Agent sections' }).getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Pause new actions' }).click();
    await page.getByRole('button', { name: 'Resume new actions' }).waitFor();
    await page.getByText('It is not an on-chain freeze', { exact: false }).waitFor();
    // The list shows the agent; phone width has no horizontal scroll.
    await page.goto(`${stack.apiUrl}/agents`);
    await page.getByText('Runs on your infrastructure').first().waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(agentUrl);
    await page.getByRole('heading', { name: 'Verified trades' }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await stack.stop(); rmSync(dir, { recursive: true, force: true }); }
});
