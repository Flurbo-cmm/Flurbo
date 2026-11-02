// Public, read-only market data for the /demo page: a fixed list of pools, no session, no wallet, short cache.
// Only reads are routed here. Trades, holdings, quotes, evidence and actions stay on the signed-in routes.

const POOL = /^0x[0-9a-f]{40}$/;
const KINDS = ['hybrid', 'conditional'], ROLES = ['live', 'settled'];
const HYBRID = /^\/api\/demo\/hybrid\/(0x[0-9a-f]{40})-([0-9]|[12][0-9]|3[01])(?:\/(market|price-history|what-if))?$/i;
const CONDITIONAL = /^\/api\/demo\/conditionals\/(0x[0-9a-f]{40})(?:\/(chances))?$/i;
const MESSAGE = /^(Invalid |Hybrid |Conditional |Choose |Select |Provide |No |This )/;
const GENERIC = 'Market request unavailable. Refresh and retry.';

export function demoPoolList(value, { hybrid = [], conditional = [] } = {}) {
  if (value === undefined || value === null) return [];
  const invalid = () => { throw Error('Invalid demo pool list'); };
  if (value.schema !== 'flurbo.demo-pools.v1' || !Array.isArray(value.pools) || value.pools.length > 8) invalid();
  const known = { hybrid: new Set(hybrid.map(item => item.pool.toLowerCase())),
    conditional: new Set(conditional.map(item => item.pool.toLowerCase())) };
  const seen = new Set();
  return value.pools.map(entry => {
    if (!entry || typeof entry !== 'object' || Object.keys(entry).sort().join() !== 'kind,pool,role') invalid();
    const pool = typeof entry.pool === 'string' ? entry.pool.toLowerCase() : '';
    if (!POOL.test(pool) || !KINDS.includes(entry.kind) || !ROLES.includes(entry.role) || !known[entry.kind].has(pool) || seen.has(pool)) invalid();
    seen.add(pool);
    return { pool, kind: entry.kind, role: entry.role };
  });
}

export function demoApi({ pools, hybrid, conditionals, priceHistory, ttlMs = 30_000, maxEntries = 300, now = Date.now }) {
  const listed = new Map(pools.map(entry => [entry.pool, entry]));
  const cache = new Map();
  const serviceFor = entry => entry.kind === 'hybrid' ? hybrid : conditionals?.questions;
  const reply = (status, body) => ({ status, body });

  async function cached(key, load) {
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttlMs) return hit.value;
    const value = await load();
    cache.delete(key);
    cache.set(key, { value, at: now() });
    while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
    return value;
  }

  const withoutAccount = value => {
    if (!value || typeof value !== 'object' || !('user' in value)) return value;
    const { user, ...rest } = value;
    return rest;
  };

  function directory() {
    return { schema: 'flurbo.demo.v1', pools: pools.map(entry => {
      const questions = (serviceFor(entry)?.list() ?? []).filter(item => item.pool.toLowerCase() === entry.pool);
      if (!questions.length) return null;
      return { pool: questions[0].pool, kind: entry.kind, role: entry.role, title: questions[0].poolTitle, closesAt: questions[0].closesAt,
        questions: questions.map(({ id, eventIndex, question, route, observationEndsAt }) => ({ id, eventIndex, question, route, observationEndsAt })) };
    }).filter(Boolean) };
  }

  function route(method, path) {
    if (path === '/api/demo') return method === 'GET' ? { key: 'directory', load: async () => directory() } : 405;
    const question = path.match(HYBRID);
    if (question) {
      const pool = question[1].toLowerCase(), id = `${pool}-${question[2]}`, op = question[3] ?? '', entry = listed.get(pool);
      const service = entry && serviceFor(entry);
      if (!service || (entry.kind !== 'hybrid' && ['market', 'price-history'].includes(op))) return 404;
      if (op === 'what-if') return method === 'POST' ? { key: `what-if ${id}`, input: true, load: input => service.whatIf(id, input) } : 405;
      if (method !== 'GET') return 405;
      if (op === 'market') return { key: `market ${id}`, load: () => service.marketSummary(id) };
      if (op === 'price-history') return priceHistory ? { key: `history ${id}`, load: () => priceHistory(id) } : 503;
      return { key: `snapshot ${id}`, load: async () => withoutAccount(await service.snapshot(id, null)) };
    }
    const decision = path.match(CONDITIONAL);
    if (decision) {
      const pool = decision[1].toLowerCase(), entry = listed.get(pool);
      if (entry?.kind !== 'conditional' || !conditionals) return 404;
      if (decision[2] === 'chances') return method === 'POST' ? { key: `chances ${pool}`, input: true, load: input => conditionals.chances(pool, input) } : 405;
      return method === 'GET' ? { key: `pool ${pool}`, load: () => conditionals.pool(pool) } : 405;
    }
    return 404;
  }

  async function handle({ method, path, search = '', input }) {
    const found = route(method, path);
    if (found === 404) return reply(404, { error: 'Demo route unavailable.' });
    if (found === 405) return reply(405, { error: 'This demo route is read only.' });
    if (found === 503) return reply(503, { error: 'Price history storage is unavailable.' });
    if (search) return reply(400, { error: 'Unexpected parameter.' });
    const key = found.input ? `${found.key} ${JSON.stringify(input ?? null)}` : found.key;
    try {
      return reply(200, await cached(key, () => found.load(input)));
    } catch (error) {
      return reply(400, { error: error instanceof Error && MESSAGE.test(error.message) ? error.message : GENERIC });
    }
  }

  return { handle };
}
