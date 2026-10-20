import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const skip = !process.env.FLURBO_TEST_PLAYWRIGHT;
const questions: string[] = JSON.parse(await readFile(new URL('./fixtures/flb1-questions.json', import.meta.url), 'utf8'));
const pool = '0x' + '44'.repeat(20), account = '0x' + '22'.repeat(20), now = Math.floor(Date.now() / 1000);
const markets = questions.map((question, eventIndex) => ({ id: `${pool}-${eventIndex}`, pool, poolTitle: 'flb.1 Overture', eventIndex, question,
  route: 'reality', closesAt: now + 7200, observationEndsAt: now + 10800 }));
const yes = [612, 540, 480, 455, 501, 377, 420, 365, 590, 512, 560, 610, 720, 300, 120, 690];
const edges = [[0, 1, 96], [0, 6, 74], [0, 7, 51], [0, 3, -12], [5, 6, 30]].map(([a, b, difference]) => ({ a, b,
  joint: Math.round(yes[a] * yes[b] / 1000) + difference, independent: Math.round(yes[a] * yes[b] / 1000), difference, scope: 2 ** a + 2 ** b }));
const deltas: Record<'yes' | 'no', Record<number, number>> = { yes: { 1: 171, 6: 74, 7: 51, 3: -35, 15: -28 }, no: { 6: -150, 1: 30, 7: -60, 3: 40, 15: 25 } };

type Leg = { eventIndex: number; side: 'yes' | 'no' };
const state: { browser: any } = { browser: null };
after(async () => { await state.browser?.close(); });

function scenario(given: Leg[]) {
  return { schema: 'flurbo.hybrid-what-if.v1', pool, blockNumber: '1234', blockHash: '0x' + '9'.repeat(64), observedAt: now, closed: false,
    unit: 'tenths_of_percentage_point', given, givenChance: 612, claim: null, reasons: {},
    questions: markets.map(({ eventIndex }) => {
      const leg = given.find(item => item.eventIndex === eventIndex);
      if (leg) return { eventIndex, yes: yes[eventIndex], givenYes: leg.side === 'yes' ? 1000 : 0, assumed: true };
      const shift = given.reduce((sum, item) => sum + (deltas[item.side][eventIndex] ?? eventIndex % 3), 0) / given.length;
      return { eventIndex, yes: yes[eventIndex], givenYes: Math.round(yes[eventIndex] + shift), assumed: false };
    }) };
}

async function session(path: string, { reducedMotion = false, viewport = { width: 1440, height: 1000 }, analysisFails = false } = {}) {
  const { chromium } = await import(pathToFileURL(process.env.FLURBO_TEST_PLAYWRIGHT!).href);
  state.browser ??= await chromium.launch({ headless: true, executablePath: process.env.FLURBO_TEST_BROWSER });
  const context = await state.browser.newContext({ viewport, reducedMotion: reducedMotion ? 'reduce' : 'no-preference' });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors: string[] = [], whatIf: any[] = [];
  page.on('pageerror', (error: Error) => errors.push(error.message));
  await page.route('**/*', async (route: any) => {
    const url = new URL(route.request().url()), route_ = url.pathname, body = route.request().postDataJSON?.() ?? null;
    if (route_ === '/api/auth/session') return route.fulfill({ json: { session: { address: account, method: 'passkey', expiresAt: Date.now() + 3600_000 } } });
    if (route_ === '/api/account/access') return route.fulfill({ json: { approved: true, testingTools: false } });
    if (route_ === '/api/account/wallets') return route.fulfill({ json: { account, wallets: [] } });
    if (route_ === '/api/account/portfolio-sources') return route.fulfill({ json: { account, wallets: [], agentWallets: [] } });
    if (route_ === '/api/market-directory') return route.fulfill({ json: { schema: 'flurbo.market-directory.v1', markets: [], oracleMarkets: [], hybridMarkets: markets } });
    const part = route_.match(/^\/api\/hybrid\/0x[0-9a-f]{40}-(\d+)(\/[a-z-]+)?$/i);
    if (part && part[2] === '/market') return route.fulfill({ json: { prices: { yes: '500000', no: '500000' }, marketNow: now, funded: true, resolved: false } });
    if (part && part[2] === '/price-history') return route.fulfill({ json: { pool, sampling: 'current', points: [] } });
    if (part && part[2] === '/web') return route.fulfill({ json: { schema: 'flurbo.hybrid-web.v1', pool, title: 'flb.1 Overture', closesAt: now + 7200, blockNumber: '1234',
      blockHash: '0x' + '9'.repeat(64), observedAt: now, estimated: true, questions, nodes: markets.map(m => ({ event: m.eventIndex, yes: yes[m.eventIndex] })), edges } });
    if (part && part[2] === '/what-if') {
      whatIf.push(body);
      if (body.claim) {
        const legs: Leg[] = [...body.claim.legs].sort((a, b) => a.eventIndex - b.eventIndex);
        const cells = Array.from({ length: 2 ** legs.length }, (_, local) => ({ state: local, pays: local === 2 ** legs.length - 1, chance: 100 + local,
          answers: legs.map((leg, i) => ({ eventIndex: leg.eventIndex, side: local >> i & 1 ? 'yes' : 'no' })) }));
        return route.fulfill({ json: { ...scenario([]), given: [], questions: [], claim: { scope: 3, mask: '8', rule: body.claim.rule, legs, chance: 100, independent: 90, difference: 10,
          cells, priceable: true, addable: Array.from({ length: 16 }, (_, i) => i).filter(i => !legs.some(leg => leg.eventIndex === i)) } } });
      }
      return route.fulfill({ json: scenario([...body.given].sort((a: Leg, b: Leg) => a.eventIndex - b.eventIndex)) });
    }
    if (part && part[2] === '/analysis') {
      if (analysisFails) return route.fulfill({ status: 400, json: { error: 'Invalid event pair' } });
      return route.fulfill({ status: 503, json: { error: 'x' } });
    }
    if (part && part[2] === '/action') return route.fulfill({ status: 503, json: { error: 'x' } });
    if (part && !part[2]) return route.fulfill({ json: { ...markets[Number(part[1])], schema: 'flurbo.hybrid-snapshot.v1', resolver: pool, eventHash: '0x' + '33'.repeat(32),
      rulesHash: '0x' + '55'.repeat(32), adapter: pool, source: { adapter: 'reality', publisher: 'Reality.eth' }, ruleAdapter: 'xml-feed.v1', marketNow: now, funded: true,
      resolved: false, delivered: false, assertionDeadline: now + 14400, reportDeadline: now + 86400, bondAtoms: '1000000', phase: 0, proposal: 0, counter: 0, result: 0,
      challengeUntil: 0, arbitrationUntil: 0, requestId: '0x' + '00'.repeat(32), sourceCaseId: '0x' + '00'.repeat(32), proposalEvidenceURI: null, reality: null, user: null } });
    if (route_.startsWith('/api/')) return route.fulfill({ status: 503, json: { error: 'Unavailable fixture' } });
    const relative = route_.startsWith('/assets/') || route_.startsWith('/brand/') ? route_.slice(1) : 'index.html';
    try {
      return route.fulfill({ body: await readFile(new URL('../dist/' + relative, import.meta.url)),
        contentType: relative.endsWith('.js') ? 'text/javascript' : relative.endsWith('.css') ? 'text/css' : relative.endsWith('.woff2') ? 'font/woff2' : relative.endsWith('.svg') ? 'image/svg+xml' : 'text/html' });
    } catch { return route.fulfill({ status: 404, body: '' }); }
  });
  await page.goto(`https://flurbopm.singu.online/markets/hybrid/${pool}/${path}`);
  return { page, errors, whatIf, close: () => context.close() };
}
const rowsOf = (page: any) => page.locator('.what-if .shift-row');
const nums = (page: any) => rowsOf(page).evaluateAll((rows: HTMLElement[]) => rows.map(row => row.querySelector('.slip-q')!.textContent));

test('the Linked tab shows What if for a 16-question pool, assuming this question is Yes', { skip }, async () => {
  const { page, errors, whatIf, close } = await session('0');
  try {
    const region = page.getByRole('region', { name: 'What if' });
    await region.waitFor();
    await region.getByRole('heading', { name: 'If Q1 is Yes' }).waitFor();
    await page.waitForFunction(() => document.querySelectorAll('.what-if .shift-row').length === 5);
    assert.deepEqual(await nums(page), ['Q2', 'Q7', 'Q8', 'Q4', 'Q16']);
    const first = rowsOf(page).first();
    const text = await first.innerText();
    assert.match(text, /Will the US Treasury 2-year/);
    assert.match(text, /54\.0%/);
    assert.match(text, /71\.1%/);
    assert.match(text, /\+17\.1 pts/);
    assert.deepEqual(whatIf[0], { given: [{ eventIndex: 0, side: 'yes' }] });
    assert.equal(await region.getByRole('radiogroup', { name: 'Assume Q1' }).getByRole('radio', { name: 'Yes' }).getAttribute('aria-checked'), 'true');
    await region.getByRole('button', { name: /^All \d+ questions$/ }).click();
    await page.waitForFunction(() => document.querySelectorAll('.what-if .shift-row').length === 15);
    const clipped = await page.$$eval('.what-if .shift-row .shift-question', (els: HTMLElement[]) => els.filter(e => e.scrollHeight > e.clientHeight + 1).length);
    assert.equal(clipped, 0);
    assert.match(await region.innerText(), /Pool estimates at block 1234\. Assuming an answer does not show that one event causes another\./);
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test('flipping or adding an assumption refetches and reorders the rows', { skip }, async () => {
  const { page, whatIf, close } = await session('0');
  try {
    const region = page.getByRole('region', { name: 'What if' });
    await page.waitForFunction(() => document.querySelectorAll('.what-if .shift-row').length === 5);
    assert.equal((await nums(page))[0], 'Q2');
    await region.getByRole('radiogroup', { name: 'Assume Q1' }).getByRole('radio', { name: 'No' }).click();
    await region.getByRole('heading', { name: 'If Q1 is No' }).waitFor();
    await page.waitForFunction(() => document.querySelector('.what-if .shift-row .slip-q')?.textContent === 'Q7');
    assert.deepEqual((await nums(page)).slice(0, 3), ['Q7', 'Q8', 'Q4']);
    assert.deepEqual(whatIf.at(-1), { given: [{ eventIndex: 0, side: 'no' }] });
    await region.getByRole('button', { name: 'Add an assumption' }).click();
    await region.getByRole('group', { name: 'Add an assumption' }).locator('.choice-row', { hasText: questions[1] }).click();
    await region.getByRole('heading', { name: 'If Q1 is No and Q2 is Yes' }).waitFor();
    assert.deepEqual(whatIf.at(-1).given, [{ eventIndex: 0, side: 'no' }, { eventIndex: 1, side: 'yes' }]);
    assert.ok(!(await nums(page)).includes('Q2'), 'an assumed question is not listed');
    await region.getByRole('button', { name: 'Remove assumption Q2' }).click();
    await region.getByRole('heading', { name: 'If Q1 is No' }).waitFor();
    assert.equal(await region.getByRole('button', { name: 'Add an assumption' }).count(), 1);
  } finally { await close(); }
});

test('Combine on a row adds the assumption and that question to the ticket on the same page', { skip }, async () => {
  const { page, close } = await session('0');
  try {
    const region = page.getByRole('region', { name: 'What if' });
    await page.waitForFunction(() => document.querySelectorAll('.what-if .shift-row').length === 5);
    await region.getByRole('button', { name: 'Combine with Q7' }).click();
    const ticket = page.getByRole('region', { name: 'Trade this market' });
    await page.locator('.slip-leg').nth(1).waitFor();
    assert.equal(await page.locator('.slip-leg').count(), 2);
    assert.match(await ticket.locator('.slip-leg').nth(1).innerText(), /Q7/);
    assert.match(page.url(), /other=6/);
    assert.equal(new URL(page.url()).pathname, `/markets/hybrid/${pool}/0`);
    assert.equal(await ticket.getByRole('radiogroup', { name: 'Your answer', exact: true }).getByRole('radio', { name: 'Yes' }).getAttribute('aria-checked'), 'true');
  } finally { await close(); }
});

test('the connections map node panel shows What if for the chosen question', { skip }, async () => {
  const { page, close } = await session('web?focus=0');
  try {
    await page.locator('#web-node-0').click();
    const region = page.getByRole('region', { name: 'What if' });
    await region.waitFor();
    await region.getByRole('heading', { name: 'If Q1 is Yes' }).waitFor();
    await page.waitForFunction(() => document.querySelectorAll('.what-if .shift-row').length >= 3);
    const link = region.getByRole('link', { name: 'Combine with Q2' });
    const href = await link.getAttribute('href');
    assert.match(href!, new RegExp(`^/markets/hybrid/${pool}/0\\?`));
    const params = new URL(href!, 'https://x.test').searchParams;
    assert.deepEqual([params.get('answer'), params.get('other'), params.get('otherAnswer'), params.get('rule')], ['yes', '1', 'yes', 'AND']);
    assert.match(await text(page.locator('.hybrid-web-panel')), /Moves most with/);
  } finally { await close(); }
});

const text = (locator: any) => locator.innerText();

test('the pair panel leads with the fallback sentence when the comparison fails', { skip }, async () => {
  const { page, close } = await session('web?focus=0', { analysisFails: true });
  try {
    await page.locator('#web-node-0').click();
    await page.locator('.web-link-row').first().click();
    const panel = page.locator('.hybrid-web-panel');
    await panel.getByText(/^This pool prices both Yes at/).waitFor();
    await panel.getByText('The pool comparison could not load. Refresh to try again.').waitFor();
    const body = await text(panel);
    assert.ok(body.indexOf('This pool prices both Yes at') < body.indexOf('The pool comparison could not load'), 'the fallback sentence comes first');
    await panel.getByRole('button', { name: 'Try again' }).waitFor();
  } finally { await close(); }
});

test('dumbbell rows have text alternatives and no motion under reduced motion', { skip }, async () => {
  const { page, close } = await session('0', { reducedMotion: true });
  try {
    await page.waitForFunction(() => document.querySelectorAll('.what-if .shift-row').length === 5);
    const first = rowsOf(page).first();
    assert.equal(await first.locator('svg[role="img"]').getAttribute('aria-label'), 'Q2 54.0 percent now, 71.1 percent if assumed, up 17.1 points');
    assert.equal(await rowsOf(page).nth(3).locator('svg[role="img"]').getAttribute('aria-label'), 'Q4 45.5 percent now, 42.0 percent if assumed, down 3.5 points');
    const motion = await page.evaluate(() => [...document.querySelectorAll('.what-if .shift-row, .what-if .shift-row *')].flatMap(e => { const c = getComputedStyle(e);
      const longest = (value: string) => Math.max(...value.split(',').map(part => parseFloat(part) * (part.trim().endsWith('ms') ? 0.001 : 1)));
      return longest(c.animationDuration) > 0.001 || longest(c.transitionDuration) > 0.001 ? [e.tagName + '.' + (e.getAttribute('class') ?? '')] : []; }));
    assert.deepEqual(motion, []);
  } finally { await close(); }
});
