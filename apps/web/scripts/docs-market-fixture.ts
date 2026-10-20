// Example pools for the /docs market screenshots. Every price, quote and comparison is read from one joint
// distribution per pool, so the singles, combinations and what-if values in the images agree with each other.
// Nothing here reaches a network or a chain.

export const POOLS = {
  rates: '0x' + 'a1'.repeat(20),
  releases: '0x' + 'b2'.repeat(20),
  activity: '0x' + 'c3'.repeat(20),
  blocks: '0x' + 'd4'.repeat(20),
} as const;
export const TRADER = '0x' + '11'.repeat(20);

const HOUR = 3600, DAY = 86400;
const zero = '0x' + '00'.repeat(32);
type Side = 'yes' | 'no';
type Rule = 'AND' | 'OR' | 'EXACTLY_ONE';
type Pool = { pool: string; title: string; route: 'mechanical' | 'reality'; questions: string[]; closesAt: number;
  observationEndsAt: number; joint: number[]; resolved: boolean; publisher: string; urls: string[] };

// P(rate cut, CPI at or below 2.8%, yield below 4%) with the cut more likely after soft inflation and lower yields
// more likely after a cut. Index bit i is question i answering Yes.
function ratesJoint() {
  const states: number[] = [];
  for (let s = 0; s < 8; s++) {
    const cut = !!(s & 1), cpi = !!(s & 2), yieldLow = !!(s & 4);
    const pCpi = cpi ? 0.48 : 0.52;
    const pCut = cpi ? (cut ? 0.8 : 0.2) : (cut ? 0.45 : 0.55);
    const pYield = cut ? (yieldLow ? 0.55 : 0.45) : (yieldLow ? 0.18 : 0.82);
    states.push(pCpi * pCut * pYield);
  }
  return states;
}

export function marketPools(now: number): Pool[] {
  return [
    { pool: POOLS.rates, title: 'Example: US rates and inflation', route: 'mechanical',
      questions: ['Will the Federal Reserve lower its policy rate at its October 2026 meeting?',
        'Will US CPI inflation for September 2026 be 2.8% or lower, year on year?',
        'Will the US 10-year Treasury yield close below 4.00% on 30 October 2026?'],
      closesAt: now + 9 * DAY + 5 * HOUR, observationEndsAt: now + 10 * DAY, joint: ratesJoint(), resolved: false,
      publisher: 'Board of Governors of the Federal Reserve System', urls: ['https://www.federalreserve.gov/monetarypolicy/openmarket.htm'] },
    { pool: POOLS.releases, title: 'Example: client releases', route: 'reality',
      questions: ['Will go-ethereum publish stable release v1.18.0 by 15 October 2026?',
        'Will reth publish stable release v2.7.0 by 15 October 2026?'],
      closesAt: now - 2 * DAY, observationEndsAt: now - DAY, joint: [0.2, 0.15, 0.25, 0.4], resolved: false,
      publisher: 'Reality.eth', urls: [] },
    { pool: POOLS.activity, title: 'Example: Ethereum network activity', route: 'mechanical',
      questions: ['Will Ethereum mainnet record more than 1.6 million transactions on 10 October 2026?',
        'Will the median Ethereum mainnet base fee on 10 October 2026 be below 2 gwei?'],
      closesAt: now - 6 * HOUR, observationEndsAt: now - 2 * HOUR, joint: [0.2, 0.3, 0.1, 0.4], resolved: false,
      publisher: 'Ethereum JSON-RPC', urls: ['https://ethereum-rpc.publicnode.com'] },
    { pool: POOLS.blocks, title: 'Example: Monad testnet blocks', route: 'mechanical',
      questions: ['Will the first Monad testnet block after 12:00 UTC on 8 October 2026 contain a transaction?',
        'Will the first Monad testnet block after 12:00 UTC on 8 October 2026 use at least 1,000,000 gas?'],
      closesAt: now - 4 * DAY, observationEndsAt: now - 4 * DAY + 600, joint: [0.1, 0.2, 0.1, 0.6], resolved: true,
      publisher: 'Monad testnet RPC', urls: ['https://testnet-rpc.monad.xyz'] },
  ];
}

const chance = (joint: number[], pays: (state: number) => boolean) => joint.reduce((sum, p, s) => sum + (pays(s) ? p : 0), 0);
const atoms = (value: number) => String(Math.round(value * 1_000_000));
const answered = (state: number, event: number, side: Side) => !!(state & (1 << event)) === (side === 'yes');
function claimPays(legs: { eventIndex: number; side: Side }[], rule: Rule) {
  return (state: number) => {
    const hits = legs.filter(leg => answered(state, leg.eventIndex, leg.side)).length;
    return rule === 'AND' ? hits === legs.length : rule === 'OR' ? hits > 0 : hits === 1;
  };
}
// A small size impact so a larger purchase averages a little more per share, as a funded pool does.
const buyCost = (probability: number, shares: number) => probability * shares * (1.004 + 0.0012 * shares);
const sellProceeds = (probability: number, shares: number) => probability * shares * (0.996 - 0.0012 * shares);

export function marketFixture(now: number) {
  const pools = marketPools(now);
  const markets = pools.flatMap(p => p.questions.map((question, eventIndex) => ({ id: `${p.pool}-${eventIndex}`, pool: p.pool,
    poolTitle: p.title, eventIndex, question, route: p.route, closesAt: p.closesAt, observationEndsAt: p.observationEndsAt })));
  const find = (id: string) => {
    const [pool, index] = id.split('-');
    const p = pools.find(item => item.pool === pool.toLowerCase());
    return p ? { p, eventIndex: Number(index) } : null;
  };
  const open = (p: Pool) => !p.resolved && now < p.closesAt;
  const marginal = (p: Pool, event: number) => chance(p.joint, s => !!(s & (1 << event)));

  function summary(id: string) {
    const { p, eventIndex } = find(id)!;
    const yes = marginal(p, eventIndex);
    return { schema: 'flurbo.hybrid-market.v1', id, pool: p.pool, marketNow: now, funded: true, resolved: p.resolved,
      prices: open(p) ? { yes: atoms(buyCost(yes, 1)), no: atoms(buyCost(1 - yes, 1)) } : { yes: null, no: null } };
  }

  function history(id: string) {
    const { p, eventIndex } = find(id)!;
    const end = Math.min(now, p.closesAt), last = marginal(p, eventIndex), points = [];
    // One sample every 8 minutes for three days, like the archive, so the chart draws no gaps.
    for (let i = 0; i <= 540; i++) {
      const t = end - (540 - i) * 480, drift = (540 - i) / 540, k = i / 12;
      const yes = Math.min(0.95, Math.max(0.05, last - 0.14 * drift * (1 - Math.cos(k / 9)) + 0.03 * Math.sin(k / 2.3) * drift + 0.012 * Math.sin(k * 1.7) * drift));
      points.push({ timestamp: t, blockNumber: String(4_000_000 + i * 480), prices: [{ event: 0, yes: atoms(buyCost(yes, 1)), no: atoms(buyCost(1 - yes, 1)) }] });
    }
    return { pool: p.pool, sampling: 'hourly', points };
  }

  function snapshot(id: string, wallet: boolean) {
    const { p, eventIndex } = find(id)!;
    const market = markets.find(m => m.id === id)!;
    const proposed = p.pool === POOLS.activity && eventIndex === 0;
    const settled = p.resolved;
    const result = settled ? (marginal(p, eventIndex) > 0.5 ? 2 : 1) : 0;
    const base = { ...market, schema: 'flurbo.hybrid-snapshot.v1', resolver: '0x' + 'e5'.repeat(20), eventHash: '0x' + '33'.repeat(32),
      rulesHash: '0x' + '55'.repeat(32), adapter: '0x' + 'f6'.repeat(20), ruleAdapter: p.route === 'mechanical' ? (p.pool === POOLS.rates ? 'json-api.v1' : 'evm-rpc.v1') : null,
      source: p.route === 'mechanical' ? { publisher: p.publisher, urls: p.urls, adapter: p.pool === POOLS.rates ? 'json-api.v1' : 'evm-rpc.v1' } : { kind: 'reality-sepolia' },
      marketNow: now, funded: true, resolved: settled, delivered: settled, assertionDeadline: p.observationEndsAt + HOUR,
      reportDeadline: p.observationEndsAt + 90 * DAY, bondAtoms: '1000000',
      phase: settled ? 3 : proposed ? 1 : 0, proposal: proposed ? 2 : settled ? result : 0, counter: 0, result,
      challengeUntil: proposed ? now + 41 * 60 : 0, arbitrationUntil: 0, requestId: zero, sourceCaseId: zero,
      proposalEvidenceURI: proposed || settled ? 'https://flurbopm.singu.online/api/pilot/evidence/0x' + '7a'.repeat(32) : null,
      reality: null as unknown, ruleURI: null as string | null, automaticAnswer: null as unknown,
      user: wallet ? { wallet: TRADER, noShares: settled && eventIndex === 1 ? '0' : '0', yesShares: settled ? (eventIndex === 0 ? '3000000' : '2000000') : '0',
        cashAtoms: '42500000', allowanceAtoms: '0', bondAllowanceAtoms: '0', bondCreditsAtoms: '0' } : null };
    if (p.route === 'reality') {
      base.ruleURI = `https://flurbopm.singu.online/api/hybrid/rules/0x${'66'.repeat(32)}`;
      base.automaticAnswer = { outcome: 2, evidenceURI: 'https://flurbopm.singu.online/api/pilot/evidence/0x' + '8b'.repeat(32), observedAt: now - DAY + 300 };
      base.reality = { chainId: 11155111, reality: '0x' + 'aa'.repeat(20), arbitrator: '0x' + 'bb'.repeat(20), questionId: '0x' + '77'.repeat(32),
        sourceNow: now, opensAt: p.observationEndsAt, finalizesAt: now + 2 * HOUR, bondWei: '1000000000000000', nextBondWei: '2000000000000000',
        disputeFeeWei: '10000000000000000', pendingArbitration: eventIndex === 0, finalized: false, creditedEthWei: '0',
        answerLabel: 'Yes', historyHash: zero, disputeStatus: eventIndex === 0 ? 1 : 0, disputeId: '42',
        court: eventIndex === 0 ? { court: '0x' + 'cc'.repeat(20), disputeId: '42', period: 2, periodLabel: 'Vote', periodEndsAt: now + 20 * HOUR,
          rounds: 1, drawn: 3, votesNeeded: 3, votesCast: 1, ruled: false, currentRuling: null, appeal: null } : null,
        links: { questionTx: 'https://sepolia.etherscan.io/tx/0x' + '9c'.repeat(32), reality: 'https://reality.eth.limo/app/#!/network/11155111/question/0x' + '77'.repeat(32),
          courtContract: 'https://sepolia.etherscan.io/address/0x' + 'cc'.repeat(20) + '#events' } };
    }
    return base;
  }

  function quote(id: string, input: any) {
    const { p, eventIndex } = find(id)!;
    const legs = Array.isArray(input?.claim) && input.claim.length ? input.claim : [{ eventIndex, side: input.side }];
    const probability = chance(p.joint, claimPays(legs, legs.length === 1 ? 'AND' : input.rule || 'AND'));
    const shares = Number(BigInt(input.quantity)) / 1e6;
    const cost = BigInt(atoms(buyCost(probability, shares)));
    return { probability, shares, cost, maximum: cost + (cost + 199n) / 200n };
  }

  function action(id: string, body: any) {
    const { action: name, input } = body;
    if (name === 'quote') {
      const { cost, maximum } = quote(id, input);
      return { action: name, buyAtoms: String(cost), maxCostAtoms: String(maximum), sellAtoms: null, minProceedsAtoms: null,
        cashAtoms: '42500000', allowanceAtoms: '0', holdingsAtoms: '0' };
    }
    if (name === 'position') return { action: name, holdingsAtoms: '0', payoutAtoms: null };
    const { cost, maximum, shares } = quote(id, input);
    const reason = name === 'approve' ? `Allow up to ${Number(maximum) / 1e6} test AUSD` : `Buy ${shares} shares for at most ${Number(maximum) / 1e6} test AUSD`;
    return { action: name, amountAtoms: String(name === 'approve' ? maximum : cost), maxCostAtoms: String(maximum), expiresAt: now + 120, reason,
      transaction: { chainId: 10143, from: TRADER, to: name === 'approve' ? '0x' + '9a'.repeat(20) : find(id)!.p.pool, data: '0x1234', value: '0x0' } };
  }

  function analysis(id: string, input: any) {
    const { p } = find(id)!;
    const a = input.a as number, b = input.b as number, rule = (input.rule || 'AND') as Rule;
    const tenths = (value: number) => Math.round(value * 1000);
    const pa = marginal(p, a), pb = marginal(p, b), joint = chance(p.joint, s => !!(s & (1 << a)) && !!(s & (1 << b)));
    const values = (shift = 0) => {
      const j = Math.min(Math.min(pa, pb), joint + shift), na = pa + shift;
      return { a: tenths(na), b: tenths(pb + shift), joint: tenths(j), givenYes: tenths(j / (pb + shift)),
        givenNo: tenths((na - j) / (1 - pb - shift)), independent: tenths(na * (pb + shift)), difference: tenths(j - na * (pb + shift)) };
    };
    const outcomes = [];
    for (const sa of ['no', 'yes'] as Side[]) for (const sb of ['no', 'yes'] as Side[]) {
      const legs = [{ eventIndex: a, side: sa }, { eventIndex: b, side: sb }];
      const paying = chance(p.joint, claimPays(legs, rule)), scenario = chance(p.joint, claimPays(legs, 'AND'));
      outcomes.push({ a: sa, b: sb, costAtoms: open(p) ? atoms(buyCost(paying, Number(input.quantity) / 1e6)) : null,
        probability: tenths(paying), scenarioProbability: tenths(scenario) });
    }
    return { schema: 'flurbo.hybrid-analysis.v1', pool: p.pool, a, b, rule, quantity: input.quantity, closed: !open(p),
      blockNumber: '4012345', blockHash: '0x' + 'ab'.repeat(32), observedAt: now, values: values(), reasons: [],
      outcomes, sensitivity: open(p) ? [{ answer: 'yes', costAtoms: atoms(buyCost(joint, 1)), values: values(0.012) },
        { answer: 'no', costAtoms: atoms(buyCost(pb - joint, 1)), values: values(-0.009) }] : [] };
  }

  const tenths = (value: number) => Math.round(value * 1000);
  const legsMatch = (legs: { eventIndex: number; side: Side }[]) => (state: number) => legs.every(leg => answered(state, leg.eventIndex, leg.side));

  function web(id: string) {
    const { p } = find(id)!;
    const edges = [];
    for (let a = 0; a < p.questions.length; a++) for (let b = a + 1; b < p.questions.length; b++) {
      const joint = tenths(chance(p.joint, s => !!(s & (1 << a)) && !!(s & (1 << b)))), independent = tenths(marginal(p, a) * marginal(p, b));
      edges.push({ a, b, joint, independent, difference: joint - independent, scope: (1 << a) | (1 << b) });
    }
    return { schema: 'flurbo.hybrid-web.v1', pool: p.pool, title: p.title, closesAt: p.closesAt, blockNumber: '4012345', blockHash: '0x' + 'ab'.repeat(32),
      observedAt: now, estimated: true, questions: p.questions, nodes: p.questions.map((_, event) => ({ event, yes: tenths(marginal(p, event)) })), edges };
  }

  function whatIf(id: string, input: any) {
    const { p } = find(id)!;
    const given = (input.given ?? []) as { eventIndex: number; side: Side }[];
    const head = { schema: 'flurbo.hybrid-what-if.v1', pool: p.pool, blockNumber: '4012345', blockHash: '0x' + 'ab'.repeat(32), observedAt: now, closed: !open(p),
      unit: 'tenths_of_percentage_point', given, reasons: {} };
    const pGiven = given.length ? chance(p.joint, legsMatch(given)) : 1;
    const questions = given.length ? p.questions.map((_, eventIndex) => {
      const leg = given.find(item => item.eventIndex === eventIndex);
      const givenYes = leg ? (leg.side === 'yes' ? 1000 : 0) : tenths(chance(p.joint, s => legsMatch(given)(s) && answered(s, eventIndex, 'yes')) / pGiven);
      return { eventIndex, yes: tenths(marginal(p, eventIndex)), givenYes, assumed: !!leg };
    }) : [];
    const legs = ((input.claim?.legs ?? []) as { eventIndex: number; side: Side }[]).slice().sort((x, y) => x.eventIndex - y.eventIndex);
    let claim = null;
    if (input.claim) {
      const rule = (input.claim.rule || 'AND') as Rule, pays = claimPays(legs, rule);
      const cells = Array.from({ length: 2 ** legs.length }, (_, local) => {
        const answers = legs.map((leg, i) => ({ eventIndex: leg.eventIndex, side: (local >> i & 1 ? 'yes' : 'no') as Side }));
        return { state: local, answers, pays: pays(legs.reduce((state, leg, i) => state | (local >> i & 1 ? 1 << leg.eventIndex : 0), 0)) || false,
          chance: tenths(chance(p.joint, legsMatch(answers))) };
      });
      const independent = tenths(cells.reduce((sum, cell) => sum + (cell.pays ? cell.answers.reduce((prod, a) => prod * (a.side === 'yes' ? marginal(p, a.eventIndex) : 1 - marginal(p, a.eventIndex)), 1) : 0), 0));
      const chanceValue = cells.filter(cell => cell.pays).reduce((sum, cell) => sum + cell.chance, 0);
      const chosen = new Set(legs.map(leg => leg.eventIndex));
      claim = { scope: legs.reduce((sum, leg) => sum + 2 ** leg.eventIndex, 0), mask: String(cells.reduce((mask, cell) => mask | (cell.pays ? 1 << cell.state : 0), 0)), rule, legs,
        chance: chanceValue, independent, difference: chanceValue - independent, cells, priceable: true,
        addable: legs.length >= 3 ? [] : p.questions.map((_, i) => i).filter(i => !chosen.has(i)) };
    }
    return { ...head, givenChance: given.length ? tenths(pGiven) : null, questions, claim };
  }

  // Portfolio: an individual and a combined position in the open pool, and a settled position ready to collect.
  const hash = (digit: string) => '0x' + digit.repeat(64);
  const held: Record<string, Record<string, [string, string]>> = {
    [POOLS.rates]: { '1:2': ['5000000', '0'], '3:8': ['4000000', '0'] },
    [POOLS.blocks]: { '1:2': ['3000000', '3000000'] },
  };
  function portfolio(path: string, body: any) {
    const match = path.match(/^\/api\/hybrid\/pool\/(0x[0-9a-f]{40})\/(account|positions|history|collected-payouts)$/);
    if (!match) return null;
    const p = pools.find(item => item.pool === match[1])!, kind = match[2];
    const snapshotHead = { blockNumber: '4012345', blockHash: hash('a'), timestamp: now };
    if (kind === 'account') return { schema: 'flurbo.hybrid-portfolio-account.v1',
      manifest: { pool: p.pool, resolver: p.pool, chainId: 10143, publication: { draft: { title: p.title, closesAt: p.closesAt,
        events: p.questions.map((question, index) => ({ id: `event-${index}`, question, route: p.route, observationEndsAt: p.observationEndsAt })) } } },
      snapshot: snapshotHead, claimScopes: held[p.pool] ? [3] : [] };
    if (kind === 'positions') return { schema: 'flurbo.hybrid-portfolio-positions.v1', owner: body.owner, snapshot: snapshotHead, resolved: p.resolved,
      rows: body.claims.map((claim: any) => { const [quantity, payoutAtoms] = String(body.owner).toLowerCase() === TRADER && held[p.pool]?.[`${claim.scope}:${claim.mask}`] || ['0', '0'];
        return { scope: claim.scope, mask: claim.mask, quantity, payoutAtoms: p.resolved ? payoutAtoms : null }; }) };
    const trades = p.pool === POOLS.rates ? [[1, 1, '2', '5000000', '3120000'], [2, 3, '8', '4000000', '1490000']]
      : p.pool === POOLS.blocks ? [[3, 1, '2', '3000000', '2310000']] : [];
    if (kind === 'history') return { complete: true, through: 4012345, target: 4012345, logs: trades.map(([index, scope, mask, quantity, paid]) => ({
      name: 'Traded', hash: hash(String(index)), index, block: 4_000_000 + Number(index), timestamp: now - (5 - Number(index)) * DAY,
      args: { trader: TRADER, owner: TRADER, scope, mask, isBuy: true, quantity, collateralAmount: paid } })) };
    return { complete: true, through: 4012345, target: 4012345, logs: [] };
  }

  // Routes one request; returns undefined for paths this fixture does not serve.
  function serve(path: string, search: URLSearchParams, body: any): unknown {
    if (path === '/api/market-directory') return { schema: 'flurbo.market-directory.v1', markets: [], oracleMarkets: [], hybridMarkets: markets };
    const portfolioBody = portfolio(path, body);
    if (portfolioBody) return portfolioBody;
    const match = path.match(/^\/api\/hybrid\/(0x[0-9a-f]{40}-\d+)(?:\/(market|price-history|action|analysis|web|what-if))?$/i);
    if (!match || !find(match[1])) return undefined;
    const [, id, op] = match;
    if (!op) return snapshot(id, search.has('wallet'));
    if (op === 'market') return summary(id);
    if (op === 'price-history') return history(id);
    if (op === 'action') return action(id, body);
    if (op === 'web') return web(id);
    if (op === 'what-if') return whatIf(id, body);
    return analysis(id, body);
  }
  return { markets, serve };
}
