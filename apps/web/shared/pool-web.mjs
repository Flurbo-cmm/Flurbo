// Read-only map of which questions in a pool are priced together.
// Two questions are linked only when some claim table (factor) names both. Values are display estimates in
// tenths of a percent and never feed a trade.
const MAX_ENUMERATED_EVENTS = 18;
const bits = scope => {
  const out = [];
  for (let event = 0; scope >> event; event += 1) if (scope >> event & 1) out.push(event);
  return out;
};

export function poolWeb({ events, factors, marginals, joint }) {
  if (!Number.isInteger(events) || events < 1 || events > 32) throw new Error('Invalid event count');
  const found = new Map();
  for (const factor of factors) {
    if (!Number.isInteger(factor.scope) || factor.scope < 1 || factor.scope >= 2 ** events)
      throw new Error('Table names a question outside the pool');
    const members = bits(factor.scope);
    for (let i = 0; i < members.length; i += 1) for (let j = i + 1; j < members.length; j += 1) {
      const key = `${members[i]}-${members[j]}`, known = found.get(key);
      if (!known || factor.scope < known.scope) found.set(key, { a: members[i], b: members[j], scope: factor.scope });
    }
  }
  const edges = [...found.values()].sort((x, y) => x.a - y.a || x.b - y.b).map(({ a, b, scope }) => {
    const values = joint(a, b);
    return values && Number.isFinite(values.joint) && Number.isFinite(values.independent)
      ? { a, b, joint: values.joint, independent: values.independent, difference: values.joint - values.independent, scope }
      : { a, b, joint: null, independent: null, difference: null, scope };
  });
  const nodes = Array.from({ length: events }, (_, event) => ({ event, yes: marginals[event] ?? null }));
  return { nodes, edges };
}

export function strongestLinks(web, event, limit = 3) {
  return web.edges.filter(edge => edge.a === event || edge.b === event)
    .map(edge => ({ other: edge.a === event ? edge.b : edge.a, difference: edge.difference, edge }))
    .sort((x, y) => Math.abs(y.difference ?? 0) - Math.abs(x.difference ?? 0) || x.other - y.other)
    .slice(0, limit);
}

// Enumerates every truth-table state with the pool's weights exp(-(max - score) / depth). Floating point, so the
// results are estimates; null when the pool is too wide to enumerate.
export function estimatePairs({ events, liquidity, factors }, pairs) {
  if (!Number.isInteger(events) || events < 1 || events > MAX_ENUMERATED_EVENTS) return null;
  const depth = Number(BigInt(liquidity));
  if (!(depth > 0)) return null;
  const tables = factors.map(factor => ({ members: bits(factor.scope), values: factor.values.map(value => Number(BigInt(value))) }));
  const size = 2 ** events, scores = new Float64Array(size);
  let max = 0;
  for (let state = 0; state < size; state += 1) {
    let score = 0;
    for (const { members, values } of tables) {
      let local = 0;
      for (let i = 0; i < members.length; i += 1) if (state >> members[i] & 1) local |= 1 << i;
      score += values[local];
    }
    scores[state] = score;
    if (score > max) max = score;
  }
  let total = 0;
  const weights = new Float64Array(size), yes = new Float64Array(events);
  for (let state = 0; state < size; state += 1) {
    const weight = Math.exp(-(max - scores[state]) / depth);
    weights[state] = weight;
    total += weight;
    for (let event = 0; event < events; event += 1) if (state >> event & 1) yes[event] += weight;
  }
  const tenths = value => Math.round(value * 1000);
  const marginals = Array.from(yes, value => tenths(value / total));
  const result = new Map();
  for (const [a, b] of pairs) {
    let both = 0;
    for (let state = 0; state < size; state += 1) if ((state >> a & 1) && (state >> b & 1)) both += weights[state];
    const jointValue = tenths(both / total), independent = tenths(yes[a] / total * (yes[b] / total));
    result.set(`${a}-${b}`, { joint: jointValue, independent, difference: jointValue - independent });
  }
  return { marginals, pairs: result };
}
