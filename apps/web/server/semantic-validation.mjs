import { createHash } from 'node:crypto';
import { validateClaim } from '../shared/claims.mjs';

// Operator-reviewed predicates only. Client text/model output never establishes a relationship.
// Values are integer observation atoms; identical observation IDs mean identical source, instrument,
// timestamp/window, sampling, units and rounding, documented by the operator in sourceRule.
const hex = (v, n) => typeof v === 'string' && new RegExp(`^0x[0-9a-f]{${n}}$`).test(v);
const integer = v => typeof v === 'string' && /^-?(0|[1-9][0-9]{0,35})$/.test(v);
const digest = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const bad = message => { throw Object.assign(new Error(message), { status: 400, code: 'INVALID_SEMANTIC_INPUT' }); };
const truth = (value, p) => ({ lt: value < BigInt(p.value), lte: value <= BigInt(p.value), gt: value > BigInt(p.value), gte: value >= BigInt(p.value), eq: value === BigInt(p.value) })[p.operator];

// Two explicit modes. "off" (the default) never reads the rules and answers with a claim-bound
// "disabled" assessment, so clients can tell an intentional switch-off from a failed check.
// Failures are never reported as "disabled".
export const SEMANTIC_NOTICE_DISABLED='Outcome compatibility checks are switched off. This purchase has not been checked.';
function parseMarket(m) {
  if (!hex(m.rulesHash, 64) || !Array.isArray(m.predicates) || m.predicates.length > 4) throw Error('Invalid semantic market binding');
  const ids = new Set();
  const predicates = m.predicates.map(p => {
    if (!Number.isInteger(p?.event) || p.event < 0 || p.event > 3 || ids.has(p.event) || typeof p.observation !== 'string' || !/^[a-zA-Z0-9:_./-]{1,160}$/.test(p.observation)
      || !['lt', 'lte', 'gt', 'gte', 'eq'].includes(p.operator) || !integer(p.value) || typeof p.sourceRule !== 'string' || p.sourceRule.length < 10 || p.sourceRule.length > 2000) throw Error('Invalid semantic predicate');
    ids.add(p.event);
    return { event: p.event, observation: p.observation, operator: p.operator, value: p.value, sourceRule: p.sourceRule };
  }).sort((a, b) => a.event - b.event);
  return { pool: m.pool, rulesHash: m.rulesHash, predicates };
}

// Parse once at startup. Errors that cannot be attributed to one pool throw (the deploy fails);
// an invalid entry for a known pool only makes that pool unavailable.
export function semanticConfig({ mode = process.env.FLURBO_SEMANTIC_MODE, rules = process.env.FLURBO_SEMANTIC_RULES_JSON } = {}) {
  const selected = mode === undefined || mode === '' || mode === 'off' ? 'disabled' : mode === 'enforce' ? 'enforced' : null;
  if (!selected) throw Error('FLURBO_SEMANTIC_MODE must be "off" or "enforce"');
  const raw = typeof rules === 'string' ? rules : '', markets = new Map(), errors = new Map();
  if (selected === 'enforced' && raw) {
    let v;
    try { v = JSON.parse(raw); } catch { throw Error('Invalid semantic rules configuration: not JSON'); }
    if (v?.schema !== 'flurbo.semantic-rules.v1' || !Array.isArray(v.markets) || v.markets.length > 50) throw Error('Invalid semantic rules configuration');
    for (const m of v.markets) {
      if (!hex(m?.pool, 40)) throw Error('Invalid semantic market binding: pool must be a lowercase address');
      if (markets.has(m.pool) || errors.has(m.pool)) { markets.delete(m.pool); errors.set(m.pool, 'Duplicate semantic rules for this pool'); continue; }
      try { markets.set(m.pool, parseMarket(m)); } catch (e) { errors.set(m.pool, e.message); }
    }
  }
  return Object.freeze({ mode: selected, revision: digest({ mode: selected, rules: selected === 'enforced' ? raw : '' }), markets, errors });
}
// Test and tooling helper: an enforced configuration from a rules JSON string.
export const semanticRegistry = (raw = '') => {
  const config = semanticConfig({ mode: 'enforce', rules: raw });
  const [error] = config.errors.values();
  if (error) throw Error(error);
  return config;
};
let active = null;
export function loadSemanticConfig(env = process.env) { active = semanticConfig({ mode: env.FLURBO_SEMANTIC_MODE, rules: env.FLURBO_SEMANTIC_RULES_JSON }); return active; }
export const activeSemanticConfig = () => active ?? loadSemanticConfig();

// Operator view: effective mode, configuration revision and per-market coverage. Contains only public configuration.
export function semanticDiagnostics(config, services) {
  const known = new Set(), markets = services.map(({ namespace, manifest }) => {
    const pool = manifest.pool.toLowerCase(), count = manifest.publication.draft.events.length, entry = config.markets.get(pool);
    known.add(pool);
    if (config.mode === 'disabled') return { namespace, pool, status: 'disabled', coveredEvents: [], eventCount: count, error: null };
    const error = config.errors.get(pool) ?? (entry && entry.rulesHash !== manifest.rulesHash ? 'Semantic rules do not match this deployment'
      : entry?.predicates.some(p => p.event >= count) ? 'Semantic predicate refers to an event outside this deployment' : null);
    const covered = entry?.predicates.map(p => p.event) ?? [];
    return { namespace, pool, status: error ? 'misconfigured' : !entry ? 'unmapped' : covered.length === count ? 'mapped' : 'partial', coveredEvents: covered, eventCount: count, error };
  });
  return { schema: 'flurbo.semantic-status.v1', mode: config.mode, configRevision: config.revision, markets,
    unusedRules: [...config.markets.keys(), ...config.errors.keys()].filter(pool => !known.has(pool)) };
}

export function assessSemantics(manifest, input, config = activeSemanticConfig(), now = Math.floor(Date.now() / 1000)) {
  if (!input || Array.isArray(input) || Object.keys(input).sort().join(',') !== 'mask,quantityAtoms,scope' || typeof input.mask !== 'string'
    || !/^[1-9][0-9]{0,2}$/.test(input.mask) || typeof input.quantityAtoms !== 'string' || !/^[1-9][0-9]{0,8}$/.test(input.quantityAtoms) || BigInt(input.quantityAtoms) > 100_000_000n) bad('Choose a supported claim and quantity.');
  const count = manifest.publication.draft.events.length;
  if (!Number.isInteger(count) || count < 1 || count > 4) throw Error('Unsupported semantic deployment');
  try { validateClaim(input.scope, input.mask, count); } catch { bad('Choose a supported claim and quantity.'); }
  const pool = manifest.pool.toLowerCase(), rulesHash = manifest.rulesHash;
  if (config.mode === 'disabled') return { schema: 'flurbo.semantic-assessment.v1', mode: 'disabled', pool, rulesHash, scope: input.scope, mask: input.mask,
    quantityAtoms: input.quantityAtoms, configRevision: config.revision, checkedAt: now, expiresAt: now + 60, notice: SEMANTIC_NOTICE_DISABLED };
  if (config.mode !== 'enforced') throw Error('Unsupported semantic mode');
  if (config.errors.has(pool)) throw Error('Semantic rules for this market are misconfigured');
  const entry = config.markets.get(pool);
  if (entry && (entry.rulesHash !== rulesHash || entry.predicates.some(p => p.event >= count))) throw Error('Semantic rules do not match this deployment');
  const predicates = entry?.predicates || [], selected = Array.from({ length: count }, (_, i) => i).filter(i => input.scope & (1 << i));
  const groups = new Map();
  for (const p of predicates) groups.set(p.observation, [...(groups.get(p.observation) || []), p]);
  const feasible = state => [...groups.values()].every(group => {
    const candidates = new Set(group.flatMap(p => [BigInt(p.value) - 1n, BigInt(p.value), BigInt(p.value) + 1n]));
    return [...candidates].some(value => group.every(p => truth(value, p) === Boolean(state & (1 << p.event))));
  });
  const pays = state => {
    const local = selected.reduce((s, event, i) => s | (state & (1 << event) ? 1 << i : 0), 0);
    return Boolean(BigInt(input.mask) & (1n << BigInt(local)));
  };
  const matrix = Array.from({ length: 1 << count }, (_, state) => ({ state, admissible: feasible(state), pays: pays(state) }));
  const admissible = matrix.filter(s => s.admissible);
  if (!admissible.length) throw Error('Semantic rules exclude every state');
  const collision = !admissible.some(s => s.pays);
  const coverage = selected.every(i => predicates.some(p => p.event === i)) ? 'complete' : predicates.length ? 'partial' : 'unknown';
  const quantity = BigInt(input.quantityAtoms);
  // Exact existing uniform-VOID fractions. Do not use feasibility filtering here: old contracts do not.
  const voidPayouts = [];
  for (let invalid = 1; invalid < 1 << count; invalid++) for (let yes = 0; yes < 1 << count; yes++) {
    if (yes & invalid) continue;
    const completions = matrix.filter(s => (s.state & ~invalid) === yes);
    // Only assert semantic consistency for observed, non-VOID answers.
    if (!completions.some(s => s.admissible)) continue;
    voidPayouts.push(quantity * BigInt(completions.filter(s => s.pays).length) / BigInt(completions.length));
  }
  const maxVoid = voidPayouts.reduce((a, b) => a > b ? a : b, 0n);
  return { schema: 'flurbo.semantic-assessment.v1', mode: 'enforced', configRevision: config.revision, pool, rulesHash, scope: input.scope, mask: input.mask, quantityAtoms: input.quantityAtoms,
    status: collision ? 'collision' : coverage === 'complete' ? 'no_declared_collision' : 'unknown', code: collision ? 'SEMANTIC_COLLISION' : coverage === 'complete' ? null : 'SEMANTICS_UNKNOWN',
    coverage, rulesDigest: digest(entry || { pool, rulesHash, predicates: [] }), checkedAt: now, expiresAt: now + 60,
    ordinaryMinimumPayoutAtoms: (admissible.every(s => s.pays) ? quantity : 0n).toString(), ordinaryMaximumPayoutAtoms: (collision ? 0n : quantity).toString(),
    maximumVoidPayoutAtoms: maxVoid.toString(), matrix, predicates,
    notice: collision ? 'These answers have no winning ordinary outcome under the configured rules. Existing VOID payouts may differ. Automated purchases are blocked.'
      : coverage === 'complete' ? 'No collision under the configured predicates. This is not a forecast or a profit guarantee.' : 'Semantic relationships are not fully configured for these events. This check does not establish real-world feasibility.' };
}

export function requireSemanticPurchase(manifest, input, config) {
  const result = assessSemantics(manifest, input, config);
  if (result.status === 'collision') throw Object.assign(new Error(result.notice), { status: 409, code: 'SEMANTIC_COLLISION' });
  return result;
}
