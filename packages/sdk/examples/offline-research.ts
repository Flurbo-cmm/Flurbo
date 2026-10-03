// Offline research walk-through. No credentials, no network, no wallet. Every number comes from the
// labelled fixture pool, which is not a live market. Run: node packages/sdk/examples/offline-research.ts
import {
  createClient, fixtureTransport, FIXTURE_NAMESPACE, FIXTURE_NOW, FIXTURE_FORECAST, DEFAULT_CONFIG,
  parseForecast, candidateClaims, decide, claimKey, memoryPaperStore, recordPaperFill, evaluatePaper,
  formatAtoms, formatPpm, marginal, both, type QuoteResult,
} from '../src/index.ts';

const client = createClient({ transport: fixtureTransport() });
console.log(`Mode: ${client.mode.toUpperCase()} (offline fixture data, not a live market)\n`);

const [entry] = await client.directory();
const market = await client.market(entry.namespace);
console.log(`${market.title}`);
market.events.forEach(e => console.log(`  [${e.index}] ${e.question}`));

// 1. A structured joint forecast over events 0 and 1, validated like any untrusted input.
const forecast = parseForecast(FIXTURE_FORECAST, { eventCount: market.events.length, pool: market.pool, now: new Date(FIXTURE_NOW * 1000) });
const [a, b] = forecast.joint.events;
console.log(`\nForecast (${forecast.source.kind}): P(A) ${formatPpm(marginal(forecast.joint, a))}, P(B) ${formatPpm(marginal(forecast.joint, b))}, P(A and B) ${formatPpm(both(forecast.joint, a, b))}`);

// 2. Model-implied pair values from the pool state (fixture). These are not executable prices.
const implied = await client.pairImplied(FIXTURE_NAMESPACE, market.pool, a, b);
console.log(`Pool-implied: P(A and B) ${implied.both! / 10}%, independence baseline ${implied.independent! / 10}%`);

// 3. Executable one-share quotes for each covered claim, then a deterministic decision.
const config = DEFAULT_CONFIG, quotes = new Map<string, QuoteResult>();
for (const claim of candidateClaims(market, forecast, config))
  quotes.set(claimKey(claim), await client.quote(FIXTURE_NAMESPACE, claim, config.quantityAtoms, market.events.length));
const decision = decide({ market, forecast, config, now: FIXTURE_NOW, quotes, implied });
console.log(`\nDecision: ${decision.outcome.toUpperCase()}`);
console.log(decision.explanation);
if (decision.proposal) {
  const p = decision.proposal;
  console.log(`Winning condition: ${p.winning.map(combo => combo.map(x => `event ${x.event} ${x.yes ? 'Yes' : 'No'}`).join(' and ')).join(' or ')}`);
  console.log(`Quoted cost ${formatAtoms(p.quoteAtoms)}, worst case ${formatAtoms(p.worstCostAtoms)}, pays ${formatAtoms(p.quantityAtoms)} test AUSD if it wins outright.`);
}

// 4. Paper trade (clearly not on-chain), then a hypothetical resolution to show accounting.
const store = memoryPaperStore();
const fill = await recordPaperFill(store, decision, { now: FIXTURE_NOW, id: 'paper-1' });
console.log(`\nPaper fill recorded (mode: ${fill.mode}, model: ${fill.model}). Nothing was sent on-chain.`);
try { await recordPaperFill(store, decision, { now: FIXTURE_NOW, id: 'paper-2' }); }
catch (error) { console.log(`Second fill of the same quote rejected: ${(error as Error).message}`); }

const unresolved = evaluatePaper(await store.fills(), { eventCount: market.events.length, resolution: null });
console.log(`Before resolution: realized ${unresolved.realized ? formatAtoms(unresolved.realized.pnlAtoms) : 'none yet'}; ${unresolved.missing.join(' ')}`);
const bothYes = evaluatePaper(await store.fills(), { eventCount: market.events.length, resolution: { yesMask: 0b011, voidMask: 0 } });
console.log(`If A and B both resolve Yes (hypothetical): realized result ${formatAtoms(bothYes.realized!.pnlAtoms)} test AUSD.`);
const voided = evaluatePaper(await store.fills(), { eventCount: market.events.length, resolution: { yesMask: 0b001, voidMask: 0b010 } });
console.log(`If A is Yes and B is VOID (hypothetical): payout ${formatAtoms(voided.realized!.payoutAtoms)}, result ${formatAtoms(voided.realized!.pnlAtoms)}. VOID is not No.`);
