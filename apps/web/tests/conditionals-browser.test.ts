import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { decodeFunctionData, encodeFunctionData, formatUnits } from 'viem';
import { condPoolAbi, shapeKey } from '../shared/conditionals.mjs';
import { pilotCashAbi } from '../shared/pilot.mjs';
import { COMBINATION_LIMIT_MESSAGE } from '../shared/pilot.mjs';

const skip = !process.env.FLURBO_TEST_PLAYWRIGHT;
const allQuestions: string[] = JSON.parse(await readFile(new URL('./fixtures/flb1-questions.json', import.meta.url), 'utf8'));
const longest = [...allQuestions].sort((a, b) => b.length - a.length)[0];
const questions = [longest, allQuestions[1], allQuestions[2]];
const pool = '0x' + '46'.repeat(20), account = '0x' + '22'.repeat(20), wallet = '0x' + '77'.repeat(20), now = Math.floor(Date.now() / 1000);
const cash = '0xa9012a055bd4e0edff8ce09f960291c09d5322dc';
const PRICE = 568_672n, PAY = 571_516n;
const state: { browser: any } = { browser: null };
after(async () => { await state.browser?.close(); });

const poolView = { schema: 'flurbo.conditional-pool.v1', id: 'cond-1', pool, title: 'cond.1 Decisions', closesAt: now + 7200, open: true,
  resolved: false, resolvedState: null, voidMask: null, observedAt: now, blockNumber: '10', blockHash: '0x' + '9'.repeat(64),
  combinationLimit: COMBINATION_LIMIT_MESSAGE,
  questions: questions.map((question, eventIndex) => ({ eventIndex, question, route: 'reality', observationEndsAt: now + 10800,
    chance: [612, 540, 480][eventIndex], pairable: eventIndex === 0 ? [1] : eventIndex === 1 ? [0, 2] : [1] })) };

async function session({ allowance = '0', viewport = { width: 1440, height: 900 }, path = `/conditionals/${pool}` } = {}) {
  const { chromium } = await import(pathToFileURL(process.env.FLURBO_TEST_PLAYWRIGHT!).href);
  state.browser ??= await chromium.launch({ headless: true, executablePath: process.env.FLURBO_TEST_BROWSER });
  const context = await state.browser.newContext({ viewport });
  await context.addInitScript((w: string) => {
    (window as any).ethereum = { isMetaMask: true, on() {}, removeListener() {}, request: async ({ method, params }: { method: string; params?: any[] }) => {
      if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [w];
      if (method === 'eth_chainId') return '0x279f';
      if (method === 'eth_sendTransaction') { (window as any).__sent = params?.[0]; return '0x' + 'ab'.repeat(32); }
      return null;
    } };
  }, wallet);
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors: string[] = [], calls: { chances: any[]; quotes: any[]; actions: any[] } = { chances: [], quotes: [], actions: [] };
  page.on('pageerror', (error: Error) => errors.push(error.message));
  await page.route('**/*', async (route: any) => {
    const url = new URL(route.request().url()), path = url.pathname, body = route.request().postDataJSON?.() ?? null;
    if (path === '/api/auth/session') return route.fulfill({ json: { session: { address: account, method: 'passkey', expiresAt: Date.now() + 3600_000 } } });
    if (path === '/api/account/access') return route.fulfill({ json: { approved: true, testingTools: false } });
    if (path === '/api/account/wallets') return route.fulfill({ json: { account, wallets: [wallet] } });
    if (path === '/api/account/portfolio-sources') return route.fulfill({ json: { account, wallets: [wallet], agentWallets: [] } });
    if (path === '/api/market-directory') return route.fulfill({ json: { schema: 'flurbo.market-directory.v1', markets: [], oracleMarkets: [], hybridMarkets: [] } });
    if (path === '/api/conditionals') return route.fulfill({ json: { schema: 'flurbo.conditional-directory.v1', pools: [{ id: 'cond-1', pool,
      title: 'cond.1 Decisions', questions, closesAt: now + 7200 }] } });
    if (path === `/api/conditionals/${pool}`) return route.fulfill({ json: poolView });
    if (path === `/api/conditionals/${pool}/holdings`) return route.fulfill({ json: { schema: 'flurbo.conditional-holdings.v1', pool, wallet, open: true,
      resolved: false, observedAt: now, holdings: [{ key: shapeKey({ conditionScope: 1, conditionMask: 2n, targetScope: 2, targetMask: 2n }),
        shape: { conditionScope: 1, conditionMask: '2', targetScope: 2, targetMask: '2' },
        condition: { rule: 'AND', legs: [{ event: 0, yes: true }] }, target: { rule: 'AND', legs: [{ event: 1, yes: true }] },
        sharesAtoms: '3000000', refundAtoms: '1800000', sellAtoms: '1650000', payoutAtoms: null }] } });
    if (path === `/api/conditionals/${pool}/chances`) {
      calls.chances.push(body);
      return route.fulfill({ json: { schema: 'flurbo.conditional-chances.v1', pool, unit: 'tenths_of_percentage_point', pairable: true, open: true,
        values: { condition: 612, target: 540, given: 643, givenNot: 500 }, reasons: {}, blockNumber: '10', blockHash: '0x' + '9'.repeat(64), observedAt: now } });
    }
    const shapeOf = (input: any) => ({ conditionScope: 2 ** input.condition[0].eventIndex, conditionMask: input.condition[0].side === 'yes' ? 2n : 1n,
      targetScope: 2 ** input.target[0].eventIndex, targetMask: input.target[0].side === 'yes' ? 2n : 1n });
    const wire = (s: any) => ({ conditionScope: s.conditionScope, conditionMask: String(s.conditionMask), targetScope: s.targetScope, targetMask: String(s.targetMask) });
    const quoteFor = (input: any) => ({ schema: 'flurbo.conditional-quote.v1', pool, shape: wire(shapeOf(input)), key: shapeKey(shapeOf(input)),
      shares: input.shares, priceAtoms: String(PRICE * BigInt(input.shares) / 1_000_000n), payAtoms: String(PAY * BigInt(input.shares) / 1_000_000n),
      perShare: String(PAY), refundAtoms: String(PAY * BigInt(input.shares) / 1_000_000n),
      payoffs: { both: input.shares, conditionOnly: '0', refund: String(PAY * BigInt(input.shares) / 1_000_000n) },
      chances: { condition: 612, target: 540, given: 643, givenNot: 500 }, reasons: {}, reads: 3, observedAt: now, blockNumber: '10',
      cashAtoms: '42000000', allowanceAtoms: allowance });
    if (path === `/api/conditionals/${pool}/quote`) { calls.quotes.push(body); return route.fulfill({ json: quoteFor(body) }); }
    if (path === `/api/conditionals/${pool}/action`) {
      calls.actions.push(body);
      const q = quoteFor(body.input);
      if (body.action === 'approve') return route.fulfill({ json: { action: 'approve', amountAtoms: q.payAtoms, quote: q, reason: 'Allow up to the price',
        transaction: { chainId: 10143, from: wallet, to: cash, value: '0x0',
          data: encodeFunctionData({ abi: pilotCashAbi, functionName: 'approve', args: [pool, BigInt(q.payAtoms)] } as any) } } });
      return route.fulfill({ json: { action: 'buy', payAtoms: q.payAtoms, priceAtoms: q.priceAtoms, expiresAt: now + 120, quote: q, reason: 'Predict',
        transaction: { chainId: 10143, from: wallet, to: pool, value: '0x0',
          data: encodeFunctionData({ abi: condPoolAbi, functionName: 'buyConditional', args: [shapeOf(body.input), BigInt(body.input.shares), BigInt(q.payAtoms), BigInt(now + 120)] } as any) } } });
    }
    const question = path.match(/^\/api\/conditionals\/0x[0-9a-f]{40}-(\d+)(\/action)?$/i);
    if (question?.[2]) return route.fulfill({ json: { action: 'quote', buyAtoms: '612000', maxCostAtoms: '615060', sellAtoms: null, minProceedsAtoms: null,
      cashAtoms: '42000000', allowanceAtoms: '0', holdingsAtoms: '0' } });
    if (path.startsWith('/api/')) return route.fulfill({ status: 503, json: { error: 'Unavailable fixture' } });
    const relative = path.startsWith('/assets/') || path.startsWith('/brand/') ? path.slice(1) : 'index.html';
    try {
      return route.fulfill({ body: await readFile(new URL('../dist/' + relative, import.meta.url)),
        contentType: relative.endsWith('.js') ? 'text/javascript' : relative.endsWith('.css') ? 'text/css' : relative.endsWith('.woff2') ? 'font/woff2' : relative.endsWith('.svg') ? 'image/svg+xml' : 'text/html' });
    } catch { return route.fulfill({ status: 404, body: '' }); }
  });
  await page.goto(`https://flurbo.tech${path}`);
  await page.getByRole('main').waitFor();
  return { page, errors, calls, close: () => context.close() };
}

test('the header shows Conditionals after Markets and opens the directory', { skip }, async () => {
  const { page, errors, close } = await session({ path: '/markets' });
  try {
    const nav = page.getByRole('navigation', { name: 'Main navigation' });
    const links = await nav.getByRole('link').allInnerTexts();
    const markets = links.indexOf('Markets');
    assert.ok(markets >= 0 && links[markets + 1] === 'Conditionals', links.join(','));
    await nav.getByRole('link', { name: 'Conditionals' }).click();
    await page.getByRole('heading', { level: 1, name: 'Conditional predictions' }).waitFor();
    assert.equal(new URL(page.url()).pathname, '/conditionals');
    assert.equal(await nav.getByRole('link', { name: 'Conditionals' }).getAttribute('aria-current'), 'page');
    await page.getByRole('link', { name: 'cond.1 Decisions', exact: true }).click();
    await page.getByRole('heading', { level: 1, name: 'cond.1 Decisions' }).waitFor();
    assert.equal(await page.title(), 'Conditional predictions | flurbo');
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test('If and Then pickers show every question in full', { skip }, async () => {
  const { page, errors, close } = await session();
  try {
    const pickers = page.getByRole('group', { name: 'If this question' });
    await pickers.waitFor();
    const text = await page.getByRole('region', { name: 'Build a conditional' }).innerText();
    assert.ok(text.includes(longest), 'the longest question appears in full');
    assert.ok(!/…|\.\.\.$/m.test(text), 'no truncation ellipsis');
    const clipped = await page.$$eval('.choice-row', (rows: HTMLElement[]) => rows.filter(row => row.scrollWidth > row.clientWidth + 1 || row.scrollHeight > row.clientHeight + 1).length);
    assert.equal(clipped, 0);
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test('choosing If and Then shows both conditional chances, the quote and the payoff rows', { skip }, async () => {
  const { page, errors, calls, close } = await session();
  try {
    const fork = page.getByRole('region', { name: 'Both cases' });
    await fork.getByText('64.3%').waitFor();
    const forkText = await fork.innerText();
    for (const part of ['Chance Q1 is Yes', '61.2%', 'If Yes', 'If No', '64.3%', '50.0%']) assert.ok(forkText.includes(part), part);
    assert.deepEqual(calls.chances.at(-1), { condition: [{ eventIndex: 0, side: 'yes' }], target: [{ eventIndex: 1, side: 'yes' }] });
    const ticket = page.getByRole('region', { name: 'Your conditional prediction', exact: true });
    await ticket.getByText(formatUnits(PAY, 6) + ' test AUSD', { exact: false }).first().waitFor();
    const ticketText = await ticket.innerText();
    for (const part of ['Price per share', 'You pay', 'Q1 is Yes and Q2 is Yes', 'Q1 is Yes and Q2 is No', 'Q1 is No', '1 test AUSD', '0 test AUSD',
      'If a question is Void, the payout averages its two answers, as for every Flurbo prediction.',
      'Conditionals on unlikely conditions cost more above the pool\'s chance.']) assert.ok(ticketText.includes(part), part);
    await fork.getByRole('button', { name: 'Predict if Q1 is No' }).click();
    await page.waitForFunction(() => document.querySelector('[data-branch="no"]')?.getAttribute('data-selected') === 'true');
    await page.waitForTimeout(450);
    assert.deepEqual(calls.quotes.at(-1).condition, [{ eventIndex: 0, side: 'no' }]);
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test('the review\'s calldata decodes to buyConditional with the shown price', { skip }, async () => {
  const { page, errors, calls, close } = await session({ allowance: '100000000' });
  try {
    const ticket = page.getByRole('region', { name: 'Your conditional prediction', exact: true });
    await ticket.getByRole('button', { name: 'Review prediction' }).click();
    const sheet = page.getByRole('dialog', { name: 'Review your conditional prediction' });
    await sheet.waitFor();
    const shown = await sheet.innerText();
    assert.ok(shown.includes(`${formatUnits(PAY, 6)} test AUSD`), shown);
    await sheet.getByRole('button', { name: 'Confirm in MetaMask' }).click();
    await page.waitForFunction(() => (window as any).__sent);
    const sent = await page.evaluate(() => (window as any).__sent);
    const decoded = decodeFunctionData({ abi: condPoolAbi, data: sent.data });
    assert.equal(decoded.functionName, 'buyConditional');
    assert.equal(decoded.args![2], PAY);
    assert.equal(sent.to.toLowerCase(), pool);
    assert.equal(calls.actions.at(-1).action, 'buy');
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test('a question that cannot pair is disabled with the combination limit message', { skip }, async () => {
  const { page, errors, close } = await session();
  try {
    const then = page.getByRole('group', { name: 'Then this question' });
    await then.waitFor();
    const third = then.getByRole('radio', { name: questions[2] });
    assert.equal(await third.isDisabled(), true);
    assert.ok((await page.getByRole('region', { name: 'Build a conditional' }).innerText()).includes(COMBINATION_LIMIT_MESSAGE));
    assert.equal(await then.getByRole('radio', { name: questions[1] }).isDisabled(), false);
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test('the page fits a phone without sideways scrolling and keeps the plan order', { skip }, async () => {
  const { page, errors, close } = await session({ viewport: { width: 375, height: 812 } });
  try {
    await page.getByRole('region', { name: 'Both cases' }).getByText('64.3%').waitFor();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    const order = await page.$$eval('[data-conditional-section]', (els: HTMLElement[]) => els.map(e => e.dataset.conditionalSection)
      .filter(Boolean));
    assert.deepEqual(order, ['build', 'decision', 'ticket', 'condition', 'holdings']);
    const tops = await page.$$eval('[data-conditional-section]', (els: HTMLElement[]) => els.map(e => e.getBoundingClientRect().top));
    assert.deepEqual([...tops].sort((a, b) => a - b), tops);
    assert.deepEqual(errors, []);
  } finally { await close(); }
});
