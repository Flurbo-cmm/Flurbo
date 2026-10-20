import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { encodeClaim } from '../shared/claims.mjs';

const skip = !process.env.FLURBO_TEST_PLAYWRIGHT;
const questions: string[] = JSON.parse(await readFile(new URL('./fixtures/flb1-questions.json', import.meta.url), 'utf8'));
const pool = '0x' + '44'.repeat(20), account = '0x' + '22'.repeat(20), wallet = '0x' + '77'.repeat(20), now = Math.floor(Date.now() / 1000);
const markets = questions.map((question, eventIndex) => ({ id: `${pool}-${eventIndex}`, pool, poolTitle: 'flb.1 Overture', eventIndex, question,
  route: 'reality', closesAt: now + 7200, observationEndsAt: now + 10800 }));
const yes = [612, 540, 480, 455, 501, 377, 420, 365, 590, 512, 560, 610, 720, 300, 120, 690];
const edges = [[0, 1, 96], [0, 6, 74], [0, 7, 51], [0, 3, -12], [5, 6, 30], [14, 15, 63]].map(([a, b, difference]) => ({ a, b,
  joint: Math.round(yes[a] * yes[b] / 1000) + difference, independent: Math.round(yes[a] * yes[b] / 1000), difference, scope: 2 ** a + 2 ** b }));
const CELLS = [120, 301, 214, 365, 130, 140, 150, 160];
const link = (...events: number[]) => events.map(event => ({ eventIndex: event, side: 'yes' as const }));

type Leg = { eventIndex: number; side: 'yes' | 'no' };
type Held = { legs: { event: number; yes: boolean }[]; rule?: 'AND' | 'OR' | 'EXACTLY_ONE'; quantity: string; payout?: string };
type Options = { viewport?: { width: number; height: number }; resolved?: boolean; held?: Held[]; path?: string;
  addable?: (legs: Leg[]) => number[]; priceable?: (legs: Leg[]) => boolean };

const claimOf = (held: Held) => encodeClaim({ events: 16, rule: held.rule ?? 'AND', legs: held.legs });
const state: { playwright: any; browser: any } = { playwright: null, browser: null };
after(async () => { await state.browser?.close(); });

async function session(options: Options = {}) {
  const { chromium } = await import(pathToFileURL(process.env.FLURBO_TEST_PLAYWRIGHT!).href);
  state.playwright ??= chromium;
  state.browser ??= await chromium.launch({ headless: true, executablePath: process.env.FLURBO_TEST_BROWSER });
  const context = await state.browser.newContext({ viewport: options.viewport ?? { width: 1440, height: 900 } });
  await context.addInitScript((w: string) => {
    (window as any).ethereum = { isMetaMask: true, on() {}, removeListener() {}, request: async ({ method }: { method: string }) =>
      method === 'eth_accounts' || method === 'eth_requestAccounts' ? [w] : method === 'eth_chainId' ? '0x279f' : null };
  }, wallet);
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors: string[] = [], calls = { whatIf: [] as any[], actions: [] as any[] };
  page.on('pageerror', (error: Error) => errors.push(error.message));
  const held = new Map((options.held ?? []).map(item => { const { scope, mask } = claimOf(item); return [`${scope}:${mask}`, item]; }));
  const resolved = options.resolved ?? false;
  await page.route('**/*', async (route: any) => {
    const url = new URL(route.request().url()), path = url.pathname, body = route.request().postDataJSON?.() ?? null;
    if (path === '/api/auth/session') return route.fulfill({ json: { session: { address: account, method: 'passkey', expiresAt: Date.now() + 3600_000 } } });
    if (path === '/api/account/access') return route.fulfill({ json: { approved: true, testingTools: false } });
    if (path === '/api/account/wallets') return route.fulfill({ json: { account, wallets: [wallet] } });
    if (path === '/api/account/portfolio-sources') return route.fulfill({ json: { account, wallets: [wallet], agentWallets: [] } });
    if (path === '/api/market-directory') return route.fulfill({ json: { schema: 'flurbo.market-directory.v1', markets: [], oracleMarkets: [], hybridMarkets: markets } });
    if (path === `/api/hybrid/pool/${pool}/account`) return route.fulfill({ json: { manifest: { pool, publication: { draft: { title: 'flb.1 Overture', closesAt: now + 7200,
      events: questions.map((question, i) => ({ id: `event-${i}`, question })) } } }, claimScopes: [...held.values()].map(item => claimOf(item).scope) } });
    if (path === `/api/hybrid/pool/${pool}/positions`) return route.fulfill({ json: { owner: body.owner, snapshot: { blockNumber: '1' },
      rows: body.claims.map(({ scope, mask }: any) => {
        const item = body.owner === wallet ? held.get(`${scope}:${mask}`) : undefined;
        return { scope, mask, quantity: item?.quantity ?? '0', payoutAtoms: resolved ? (item?.payout ?? '0') : null };
      }) } });
    if (path === `/api/hybrid/pool/${pool}/history` || path === `/api/hybrid/pool/${pool}/collected-payouts`) return route.fulfill({ json: { complete: true, logs: [] } });
    const part = path.match(/^\/api\/hybrid\/0x[0-9a-f]{40}-(\d+)(\/[a-z-]+)?$/i);
    if (part && part[2] === '/market') return route.fulfill({ json: { prices: { yes: String(yes[Number(part[1])] * 1000 + 26000), no: String((1000 - yes[Number(part[1])]) * 1000 + 26000) }, marketNow: now, funded: true, resolved } });
    if (part && part[2] === '/price-history') return route.fulfill({ json: { pool, sampling: 'current', points: [] } });
    if (part && part[2] === '/web') return route.fulfill({ json: { schema: 'flurbo.hybrid-web.v1', pool, title: 'flb.1 Overture', closesAt: now + 7200, blockNumber: '1234',
      blockHash: '0x' + '9'.repeat(64), observedAt: now, estimated: true, questions, nodes: markets.map(m => ({ event: m.eventIndex, yes: yes[m.eventIndex] })), edges } });
    if (part && part[2] === '/what-if') {
      calls.whatIf.push(body);
      const legs: Leg[] = body.claim ? [...body.claim.legs].sort((a: Leg, b: Leg) => a.eventIndex - b.eventIndex) : [];
      const rule = body.claim?.rule ?? 'AND';
      const cells = Array.from({ length: 2 ** legs.length }, (_, local) => {
        const answers = legs.map((leg, i) => ({ eventIndex: leg.eventIndex, side: local >> i & 1 ? 'yes' : 'no' }));
        const hits = answers.map((answer, i) => answer.side === legs[i].side).filter(Boolean).length;
        const pays = rule === 'AND' ? hits === legs.length : rule === 'OR' ? hits > 0 : hits === 1;
        return { state: local, answers, pays, chance: CELLS[local] };
      });
      const chance = cells.filter(cell => cell.pays).reduce((sum, cell) => sum + cell.chance, 0);
      const priceable = options.priceable ? options.priceable(legs) : true;
      return route.fulfill({ json: { schema: 'flurbo.hybrid-what-if.v1', pool, blockNumber: '1234', blockHash: '0x' + '9'.repeat(64), observedAt: now, closed: false,
        unit: 'tenths_of_percentage_point', given: body.given, givenChance: null, questions: [], reasons: {},
        claim: body.claim ? { ...encodeClaim({ events: 16, rule, legs: legs.map(leg => ({ event: leg.eventIndex, yes: leg.side === 'yes' })) }), rule, legs,
          chance, independent: chance - 62, difference: 62, cells, priceable, addable: legs.length >= 3 ? []
            : options.addable ? options.addable(legs) : Array.from({ length: 16 }, (_, i) => i).filter(i => !legs.some(leg => leg.eventIndex === i)) } : null } });
    }
    if (part && part[2] === '/action') {
      calls.actions.push(body);
      const { action, input } = body;
      const claim = encodeClaim({ events: 16, rule: input?.rule ?? 'AND', legs: (input?.claim ?? []).map((leg: Leg) => ({ event: leg.eventIndex, yes: leg.side === 'yes' })) });
      const heldItem = held.get(`${claim.scope}:${claim.mask}`);
      if (action === 'quote') {
        if (options.priceable && !options.priceable(input.claim)) return route.fulfill({ status: 400, json: { error: 'Hybrid comparison unavailable' } });
        const combined = input.claim.length > 1;
        return route.fulfill({ json: { action, buyAtoms: combined ? '214350' : '638120', maxCostAtoms: combined ? '215422' : '641311',
          sellAtoms: heldItem && BigInt(heldItem.quantity) >= BigInt(input.quantity) ? '1200000' : null,
          minProceedsAtoms: heldItem ? '1194000' : null, cashAtoms: '42000000', allowanceAtoms: '0', holdingsAtoms: heldItem?.quantity ?? '0' } });
      }
      if (action === 'position') return route.fulfill({ json: { action, holdingsAtoms: heldItem?.quantity ?? '0', payoutAtoms: heldItem?.payout ?? '0' } });
      return route.fulfill({ json: { action, amountAtoms: heldItem?.payout ?? '1', reason: `${action} prepared`, transaction: { chainId: 10143, from: wallet, to: pool, data: '0x1234', value: '0x0' } } });
    }
    if (part && !part[2]) {
      const i = Number(part[1]);
      return route.fulfill({ json: { ...markets[i], schema: 'flurbo.hybrid-snapshot.v1', resolver: pool, eventHash: '0x' + '33'.repeat(32), rulesHash: '0x' + '55'.repeat(32),
        adapter: pool, source: { adapter: 'reality', publisher: 'Reality.eth' }, ruleAdapter: 'xml-feed.v1', marketNow: resolved ? now + 99999 : now, funded: true, resolved,
        delivered: resolved, assertionDeadline: now + 14400, reportDeadline: now + 86400, bondAtoms: '1000000', phase: resolved ? 3 : 0, proposal: 0, counter: 0,
        result: resolved ? 2 : 0, challengeUntil: 0, arbitrationUntil: 0, requestId: '0x' + '00'.repeat(32), sourceCaseId: '0x' + '00'.repeat(32), proposalEvidenceURI: null,
        reality: null, user: url.searchParams.has('wallet') ? { wallet, noShares: '0', yesShares: '0', cashAtoms: '42000000', allowanceAtoms: '0',
          bondAllowanceAtoms: '0', bondCreditsAtoms: '0' } : null } });
    }
    if (path.startsWith('/api/')) return route.fulfill({ status: 503, json: { error: 'Unavailable fixture' } });
    const relative = path.startsWith('/assets/') || path.startsWith('/brand/') ? path.slice(1) : 'index.html';
    try {
      return route.fulfill({ body: await readFile(new URL('../dist/' + relative, import.meta.url)),
        contentType: relative.endsWith('.js') ? 'text/javascript' : relative.endsWith('.css') ? 'text/css' : relative.endsWith('.woff2') ? 'font/woff2' : relative.endsWith('.svg') ? 'image/svg+xml' : 'text/html' });
    } catch { return route.fulfill({ status: 404, body: '' }); }
  });
  await page.goto(`https://flurbopm.singu.online/markets/hybrid/${pool}/${options.path ?? '0'}`);
  const ticket = page.getByRole('region', { name: 'Trade this market' });
  await ticket.waitFor();
  return { page, ticket, errors, calls, close: () => context.close() };
}
const text = (locator: any) => locator.innerText();
const fits = (page: any, selector: string) => page.$$eval(selector, (els: HTMLElement[]) => els.map(e => ({ client: e.clientHeight, scroll: e.scrollHeight, text: e.innerText.slice(0, 40) })));

test('the add-a-linked-question area is visible in the first viewport at 1440x900 and within one screen of the answer on a phone', { skip }, async () => {
  const desktop = await session();
  try {
    const add = desktop.ticket.getByRole('group', { name: 'Add a linked question' });
    await add.waitFor();
    await desktop.page.locator('.slip-suggestion').nth(2).waitFor();
    const box = await add.boundingBox();
    assert.ok(box && box.y < 900 && box.y + 60 < 900, `add area at ${box?.y}`);
    assert.equal(await desktop.page.locator('.slip-suggestion').count(), 3);
    assert.equal(await desktop.page.locator('.slip-leg').count(), 1);
    assert.deepEqual(desktop.errors, []);
  } finally { await desktop.close(); }
  const phone = await session({ viewport: { width: 390, height: 844 } });
  try {
    const add = phone.ticket.getByRole('group', { name: 'Add a linked question' });
    await add.waitFor();
    const top = (await add.boundingBox())!.y, answers = (await phone.ticket.getByRole('heading', { name: 'Your answers' }).boundingBox())!.y;
    assert.ok(top - answers < 844, `${top - answers} px from the answer to the add area`);
    assert.deepEqual(phone.errors, []);
  } finally { await phone.close(); }
});

test('one tap on a suggestion makes a two-answer prediction with the rule, payout sentence, outcome map and pool chance', { skip }, async () => {
  const { page, ticket, calls, errors, close } = await session();
  try {
    const suggestions = page.locator('.slip-suggestion');
    assert.match(await text(suggestions.nth(0)), /Q2[\s\S]*\+9\.6 pts/);
    assert.match(await text(suggestions.nth(1)), /Q7[\s\S]*\+7\.4 pts/);
    assert.match(await text(suggestions.nth(2)), /Q8[\s\S]*\+5\.1 pts/);
    await suggestions.nth(0).click();
    await page.locator('.slip-leg').nth(1).waitFor();
    assert.equal(await page.locator('.slip-leg').count(), 2);
    const rule = ticket.getByRole('radiogroup', { name: 'Pays when' });
    await rule.waitFor();
    assert.deepEqual(await rule.getByRole('radio').allInnerTexts(), ['All correct', 'At least one', 'Exactly one']);
    await ticket.getByText('Pays 1 test AUSD a share if Q1 is Yes and Q2 is Yes.').waitFor();
    await ticket.getByRole('table', { name: 'Outcome map. Marked outcomes pay.' }).waitFor();
    const pool = ticket.locator('.slip-pool');
    await pool.getByText('36.5%').waitFor();
    const figures = await text(pool);
    assert.match(figures, /Pool chance this pays\s+36\.5%/);
    assert.match(figures, /If the questions were unrelated\s+30\.3%/);
    assert.match(figures, /Priced together\s+\+6\.2 pts/);
    assert.match(await text(ticket), /Pool estimates at block 1234\./);
    assert.deepEqual(calls.whatIf.at(-1).claim, { legs: [{ eventIndex: 0, side: 'yes' }, { eventIndex: 1, side: 'yes' }], rule: 'AND' });
    assert.match(page.url(), /other=1/);
    await rule.getByRole('radio', { name: 'At least one' }).click();
    await ticket.getByText('Pays 1 test AUSD a share if at least one is right: Q1 Yes or Q2 Yes.').waitFor();
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test('every question in the slip, the suggestions and the full list shows its whole text', { skip }, async () => {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const { page, ticket, close } = await session({ viewport });
    try {
      await page.locator('.slip-suggestion').nth(0).click();
      await page.locator('.slip-leg').nth(1).waitFor();
      await ticket.getByRole('button', { name: /^All \d+ questions in this pool$/ }).click();
      await ticket.getByRole('group', { name: 'Add a question' }).waitFor();
      for (const selector of ['.slip-question', '.slip-suggestion', '.slip-add .choice-row']) {
        const rows = await fits(page, selector);
        assert.ok(rows.length >= 1, selector);
        for (const row of rows) assert.ok(row.scroll <= row.client + 1, `${viewport.width}: ${selector} clips "${row.text}" (${row.client} < ${row.scroll})`);
      }
      assert.ok((await page.locator('.slip-add .choice-row').count()) >= 12);
    } finally { await close(); }
  }
});

test('three answers replace the add area with the limit message, and removing one brings it back', { skip }, async () => {
  const { page, ticket, close } = await session();
  try {
    await page.locator('.slip-suggestion').nth(0).click();
    await page.locator('.slip-leg').nth(1).waitFor();
    await page.locator('.slip-suggestion').nth(0).click();
    await page.locator('.slip-leg').nth(2).waitFor();
    assert.equal(await ticket.getByRole('group', { name: 'Add a linked question' }).count(), 0);
    await ticket.getByText('Three questions is the most one prediction can combine. Remove one to add another.').waitFor();
    assert.equal(await page.locator('.slip-join').count(), 2);
    await ticket.getByRole('button', { name: 'Remove Q2' }).click();
    await ticket.getByRole('group', { name: 'Add a linked question' }).waitFor();
    assert.equal(await page.locator('.slip-leg').count(), 2);
    assert.match(await text(page.locator('.slip-leg').nth(1)), /Q7/);
    assert.equal(await ticket.getByRole('radiogroup', { name: 'Answer for Q7' }).getByRole('radio', { name: 'Yes' }).getAttribute('aria-checked'), 'true');
  } finally { await close(); }
});

test('a combination the pool cannot price is not offered, and an unpriceable quote disables the review button with a reason', { skip }, async () => {
  const offered = [1, 3, 6, 9];
  const { page, ticket, close } = await session({
    addable: legs => legs.length === 1 ? offered : [],
    priceable: legs => !legs.some(leg => leg.eventIndex === 6) || legs.length === 1 });
  try {
    await ticket.getByRole('button', { name: /^All \d+ questions in this pool$/ }).click();
    await ticket.getByRole('group', { name: 'Add a question' }).waitFor();
    await page.waitForFunction((count: number) => document.querySelectorAll('.slip-add .choice-row').length === count, offered.length);
    const shown = await page.locator('.slip-add .choice-row').allInnerTexts();
    assert.equal(shown.length, offered.length);
    assert.ok(!shown.some(row => row.includes(questions[2])), 'an unpriceable question is not offered');
    await ticket.getByRole('button', { name: 'Hide the full list' }).click();
    await page.locator('.slip-suggestion', { hasText: 'Q7' }).click();
    await page.locator('.slip-leg').nth(1).waitFor();
    await ticket.getByText('The pool cannot price these questions together. Remove an answer or choose another question.').waitFor();
    const review = ticket.getByRole('button', { name: /^Review (purchase|AUSD approval)/ });
    assert.ok(await review.count() === 0 || await review.isDisabled());
    await ticket.getByRole('button', { name: 'Remove Q7' }).click();
    await ticket.getByRole('button', { name: /^Review (purchase|AUSD approval)/ }).waitFor();
  } finally { await close(); }
});

test('the review lists each answer on its own line and never prints AND, OR or EXACTLY_ONE tokens', { skip }, async () => {
  const { page, ticket, close } = await session();
  try {
    await page.locator('.slip-suggestion').nth(0).click();
    await page.locator('.slip-leg').nth(1).waitFor();
    await page.locator('.slip-suggestion').nth(0).click();
    await page.locator('.slip-leg').nth(2).waitFor();
    const review = ticket.getByLabel('Current prediction quote');
    await review.waitFor();
    const lines = review.locator('.review-legs li');
    assert.equal(await lines.count(), 3);
    assert.match(await text(lines.nth(0)), /Q1[\s\S]*Yes[\s\S]*Will the US Treasury 10-year/);
    assert.match(await text(lines.nth(2)), /Q7[\s\S]*Yes[\s\S]*Will the Kraken/);
    await review.getByText('Pays when all are correct').waitFor();
    await ticket.getByRole('radiogroup', { name: 'Pays when' }).getByRole('radio', { name: 'Exactly one' }).click();
    await review.getByText('Pays when exactly one is correct').waitFor();
    const all = await text(ticket);
    assert.doesNotMatch(all, /\b(AND|OR|EXACTLY_ONE|EXACTLY ONE)\b/);
    assert.match(await text(review), /Payout if it pays\s+1 test AUSD/);
    assert.match(await text(review), /The most you can lose, plus network gas\./);
    assert.doesNotMatch(await text(review), /Possible loss/);
  } finally { await close(); }
});

const heldBoth: Held[] = [{ legs: [{ event: 0, yes: true }, { event: 6, yes: true }], quantity: '2000000', payout: '2000000' },
  { legs: [{ event: 0, yes: true }], quantity: '1000000', payout: '1000000' },
  { legs: [{ event: 1, yes: true }, { event: 2, yes: false }], quantity: '1000000', payout: '0' }];

test('sell lists the positions this wallet holds in the pool and fills the slip from one', { skip }, async () => {
  const { page, ticket, calls, close } = await session({ held: heldBoth });
  try {
    await ticket.getByRole('radiogroup', { name: 'Buy or sell' }).getByRole('radio', { name: 'Sell' }).click();
    const held = ticket.getByRole('region', { name: 'Your positions in this pool' });
    await held.waitFor();
    const rows = held.locator('.held-row');
    await page.waitForFunction(() => document.querySelectorAll('.held-row').length >= 3);
    assert.match(await text(held), /Q1 Yes and Q7 Yes, all correct[\s\S]*2 shares/);
    const other = held.getByRole('link', { name: 'Sell on Q2' });
    const href = await other.getAttribute('href');
    assert.match(href!, new RegExp(`^/markets/hybrid/${pool}/1\\?`));
    assert.match(href!, /trade=sell/);
    await rows.filter({ hasText: 'Q1 Yes and Q7 Yes' }).getByRole('button', { name: 'Sell this position' }).click();
    await page.locator('.slip-leg').nth(1).waitFor();
    assert.match(await text(page.locator('.slip-leg').nth(1)), /Q7/);
    assert.equal(await ticket.getByRole('radiogroup', { name: 'Pays when' }).getByRole('radio', { name: 'All correct' }).getAttribute('aria-checked'), 'true');
    assert.match(page.url(), /trade=sell/);
    await ticket.getByRole('button', { name: 'Review sale' }).waitFor();
    const quote = calls.actions.filter(item => item.action === 'quote').at(-1);
    assert.deepEqual(quote.input.claim, [{ eventIndex: 0, side: 'yes' }, { eventIndex: 6, side: 'yes' }]);
    assert.equal(quote.input.rule, 'AND');
    await ticket.getByText('Find another combination').waitFor();
  } finally { await close(); }
});

test('a resolved pool lists combined positions with their payouts and collects one without re-entering it', { skip }, async () => {
  const { page, ticket, calls, close } = await session({ resolved: true, held: heldBoth });
  try {
    const held = ticket.getByRole('region', { name: 'Your positions in this pool' });
    await held.waitFor();
    await page.waitForFunction(() => document.querySelectorAll('.held-row').length >= 2);
    const rows = held.locator('.held-row');
    const combined = rows.filter({ hasText: 'Q1 Yes and Q7 Yes' });
    assert.match(await text(combined), /2 test AUSD/);
    await combined.getByRole('button', { name: 'Collect 2 test AUSD' }).click();
    const sent = calls.actions.filter(item => item.action === 'redeem').at(-1);
    assert.equal(sent.input.quantity, '2000000');
    assert.equal(sent.input.rule, 'AND');
    assert.deepEqual(sent.input.claim, [{ eventIndex: 0, side: 'yes' }, { eventIndex: 6, side: 'yes' }]);
    assert.match(await text(rows.filter({ hasText: 'Q2 Yes and Q3 No' })), /No payout/);
    assert.ok(await rows.filter({ hasText: 'Q2 Yes and Q3 No' }).getByRole('link', { name: 'Open Q2' }).count());
  } finally { await close(); }
});

test('Your position lists combined positions that include this question', { skip }, async () => {
  const { page, close } = await session({ held: heldBoth });
  try {
    const position = page.getByRole('region', { name: 'Your position' });
    await position.waitFor();
    await page.waitForFunction(() => /Q1 Yes and Q7 Yes/.test(document.querySelector('[aria-label="Your position"]')?.textContent ?? ''));
    const body = await text(position);
    assert.match(body, /Yes\s+0 shares/);
    assert.match(body, /Q1 Yes and Q7 Yes, all correct\s+2 shares/);
    assert.doesNotMatch(body, /Q2 Yes and Q3 No/);
  } finally { await close(); }
});

test('Combine on a Linked row adds that question to the ticket and moves focus to it', { skip }, async () => {
  const { page, ticket, close } = await session();
  try {
    const linked = page.getByRole('region', { name: 'Connections' });
    await linked.waitFor();
    await linked.getByRole('button', { name: 'Combine with Q2' }).click();
    await page.locator('.slip-leg').nth(1).waitFor();
    assert.match(await text(page.locator('.slip-leg').nth(1)), /Q2/);
    const focused = await page.evaluate(() => { const e = document.activeElement as HTMLElement | null;
      return { role: e?.getAttribute('role'), inLeg: !!e?.closest('.slip-leg:nth-child(3)'), label: e?.closest('[role="radiogroup"]')?.getAttribute('aria-labelledby') };
    });
    assert.equal(focused.role, 'radio');
    assert.ok(focused.inLeg || focused.label, JSON.stringify(focused));
    assert.equal(await page.evaluate(() => (document.activeElement?.closest('.slip-leg')?.querySelector('.slip-q') as HTMLElement | null)?.innerText), 'Q2');
    assert.match(page.url(), /other=1/);
    await ticket.getByRole('radiogroup', { name: 'Pays when' }).waitFor();
  } finally { await close(); }
});

test('the ticket column stays sticky and fits the window with three answers', { skip }, async () => {
  const { page, close } = await session();
  try {
    await page.locator('.slip-suggestion').nth(0).click();
    await page.locator('.slip-leg').nth(1).waitFor();
    await page.locator('.slip-suggestion').nth(0).click();
    await page.locator('.slip-leg').nth(2).waitFor();
    const sidebar = await page.evaluate(() => { const e = document.querySelector('.market-sidebar')!; const c = getComputedStyle(e);
      return { sticky: c.position, overflow: c.overflowY, height: e.getBoundingClientRect().height, viewport: innerHeight, limit: parseFloat(c.maxHeight) }; });
    assert.equal(sidebar.sticky, 'sticky');
    assert.equal(sidebar.overflow, 'auto');
    assert.ok(sidebar.height <= sidebar.limit + 1 && sidebar.limit < sidebar.viewport, 'the ticket column fits inside the window and scrolls inside itself');
  } finally { await close(); }
});

test('y and n still choose this question\'s answer with two answers in the slip', { skip }, async () => {
  const { page, ticket, close } = await session();
  try {
    await page.locator('.slip-suggestion').nth(0).click();
    await page.locator('.slip-leg').nth(1).waitFor();
    const anchor = ticket.getByRole('radiogroup', { name: 'Your answer', exact: true });
    await page.locator('body').press('n');
    await page.waitForFunction(() => new URL(location.href).searchParams.get('answer') === 'no');
    assert.equal(await anchor.getByRole('radio', { name: 'No' }).getAttribute('aria-checked'), 'true');
    assert.equal(await ticket.getByRole('radiogroup', { name: 'Answer for Q2' }).getByRole('radio', { name: 'Yes' }).getAttribute('aria-checked'), 'true');
    await page.locator('body').press('y');
    await page.waitForFunction(() => new URL(location.href).searchParams.get('answer') === 'yes');
    await page.locator('body').press('c');
    const focused = await page.evaluate(() => document.activeElement?.textContent ?? '');
    assert.match(focused, /Add a linked question/);
  } finally { await close(); }
});
