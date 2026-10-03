// Replacing the reference strategy and research without changing the SDK. The runner accepts any object
// with the Strategy or Forecaster shape; policy checks, signing, the journal and recovery stay the SDK's.
//
//   node packages/sdk/examples/custom-strategy.ts flurbo-agent.json [--once]
//
// This strategy only trades relationships: it ignores single-event claims and requires the forecast to say
// the two events are related (the joint differs from independence by at least 5 percentage points). It then
// buys the combination with the largest edge per unit of worst-case cost, capped by its own budget.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { agentRunner, parseConfig, type Strategy } from '../src/node/runner.ts';
import { allOf, anyOf, exactlyOne, claimKey, claimProbability, marginal, both, buyLimit, PPM, MODEL_SCHEMA, type Claim } from '../src/index.ts';
import type { Forecaster } from '../src/node/research.ts';

const relationshipOnly: Strategy = {
  id: 'relationship-only', version: '1.0.0',
  async decide({ market, forecast, quote }) {
    const [a, b] = forecast.joint.events, n = market.events.length;
    const pA = marginal(forecast.joint, a), pB = marginal(forecast.joint, b), pAB = both(forecast.joint, a, b), independent = pA * pB / PPM;
    const gap = pAB > independent ? pAB - independent : independent - pAB;
    if (gap < 50_000n) return { outcome: 'abstain', reasons: ['no_relationship_edge'], explanation: 'The forecast treats the events as nearly independent; nothing relationship-specific to trade.', proposal: null };
    const claims: Claim[] = [];
    for (const ya of [true, false]) for (const yb of [true, false]) claims.push(allOf(market.pool, n, [{ event: a, yes: ya }, { event: b, yes: yb }]));
    claims.push(anyOf(market.pool, n, [{ event: a, yes: true }, { event: b, yes: true }]), exactlyOne(market.pool, n, [{ event: a, yes: true }, { event: b, yes: true }]));
    const quantity = 1_000_000n, quotes = await quote(claims, quantity);
    let best: { claim: Claim; quoteAtoms: bigint; score: bigint; edge: bigint } | null = null;
    for (const claim of claims) {
      const q = quotes.get(claimKey(claim));
      if (!q || q.status !== 'ok') continue;
      const worst = buyLimit(q.quote.amountAtoms, 50), expected = quantity * claimProbability(forecast.joint, claim) / PPM, edge = expected - worst;
      const score = edge * 10_000n / worst; // edge per unit of worst-case cost, in bps
      if (edge > 20_000n && score >= 1_000n && worst <= 1_500_000n && (!best || score > best.score)) best = { claim, quoteAtoms: q.quote.amountAtoms, score, edge };
    }
    if (!best) return { outcome: 'abstain', reasons: ['edge_below_threshold'], explanation: 'No combination clears 10% edge per unit of worst-case cost within budget.', proposal: null };
    return { outcome: 'propose', reasons: [], explanation: `Relationship trade: edge ${best.edge} atoms, ${best.score} bps of worst-case cost.`,
      proposal: { claim: best.claim, quantityAtoms: quantity, quoteAtoms: best.quoteAtoms, slippageBps: 50, edgeAtoms: best.edge, edgeBps: Number(best.score) } };
  },
};

// A custom research implementation (not a language model): it reads the retrieved text for keywords and
// produces the same validated output format. Labelled "custom", never "AI".
const keywordResearch: Forecaster = {
  kind: 'custom', name: 'keyword-rules',
  async complete(prompt) {
    const text = prompt.user.toLowerCase(), ids = [...prompt.user.matchAll(/<evidence id="([^"]+)"/g)].map(m => m[1]);
    const tagged = (text.match(/tagged|released|published/g) ?? []).length, together = /same day|together|shared/.test(text);
    const pBoth = Math.min(800_000, 300_000 + tagged * 100_000 + (together ? 150_000 : 0)), pOne = Math.floor((1_000_000 - pBoth) / 3);
    return JSON.stringify({ schema: MODEL_SCHEMA, abstain: ids.length === 0, abstainReason: ids.length ? null : 'insufficient_evidence', events: [0, 1],
      statesPpm: [1_000_000 - pBoth - 2 * pOne, pOne, pOne, pBoth], evidenceIds: ids.slice(0, 3), assumptions: ['Keyword counts reflect release progress.'],
      uncertainty: 'Keyword rules ignore context.', explanation: `Rule-based: ${tagged} release keywords${together ? ', evidence of a shared schedule' : ''}.` });
  },
};

const path = resolve(process.argv[2] ?? 'flurbo-agent.json');
const config = parseConfig(JSON.parse(readFileSync(path, 'utf8')));
const runner = agentRunner({ config: { ...config, stateDir: resolve(path, '..', config.stateDir) }, strategy: relationshipOnly, forecaster: keywordResearch });
process.once('SIGINT', () => runner.requestStop());
await runner.run({ once: process.argv.includes('--once') });
