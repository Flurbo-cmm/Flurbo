// Read-only map of which questions in a pool are priced together.
// Two questions are linked only when some claim table (factor) names both. Values are display estimates in
// tenths of a percent and never feed a trade.
const bits = scope => {
  const out = [];
  for (let event = 0; event < 32; event += 1) if (Math.floor(scope / 2 ** event) % 2 === 1) out.push(event);
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

const logAdd = (x, y) => x === -Infinity ? y : y === -Infinity ? x : Math.max(x, y) + Math.log1p(Math.exp(-Math.abs(x - y)));

// Eliminates the questions in the pool's order, so no joined table ever names more than three of them.
function logMass(order, tables, evidence) {
  let pending = tables;
  for (const event of order) {
    const bucket = pending.filter(table => table.members.includes(event)), rest = pending.filter(table => !table.members.includes(event));
    const joined = [...new Set([event, ...bucket.flatMap(table => table.members)])].sort((x, y) => x - y);
    const remaining = joined.filter(member => member !== event);
    const out = new Array(2 ** remaining.length).fill(-Infinity);
    for (let local = 0; local < 2 ** joined.length; local += 1) {
      const answer = member => local >> joined.indexOf(member) & 1;
      if (evidence.has(event) && evidence.get(event) !== Boolean(answer(event))) continue;
      let value = 0;
      for (const table of bucket) value += table.values[table.members.reduce((at, member, i) => at | answer(member) << i, 0)];
      const at = remaining.reduce((index, member, i) => index | answer(member) << i, 0);
      out[at] = logAdd(out[at], value);
    }
    pending = [...rest, { members: remaining, values: out }];
  }
  return pending.reduce((sum, table) => sum + table.values[0], 0);
}

// Estimates from the pool's weights exp(score / depth) by log-domain factor elimination. Floating point, so the
// results are estimates; null when the order is invalid or a joined table would name more than three questions.
export function estimatePairs({ events, liquidity, order, factors }, pairs) {
  if (!Number.isInteger(events) || events < 1 || events > 32) return null;
  if (!Array.isArray(order) || order.length !== events || new Set(order).size !== events
    || order.some(event => !Number.isInteger(event) || event < 0 || event >= events)) return null;
  const depth = Number(BigInt(liquidity));
  if (!(depth > 0)) return null;
  const tables = [];
  for (const factor of factors) {
    const members = Number.isInteger(factor.scope) && factor.scope >= 1 && factor.scope < 2 ** events ? bits(factor.scope) : [];
    if (!members.length || members.length > 3 || !Array.isArray(factor.values) || factor.values.length !== 2 ** members.length) return null;
    tables.push({ members, values: factor.values.map(value => Number(BigInt(value)) / depth) });
  }
  let scopes = tables.map(table => table.members);
  for (const event of order) {
    const joined = [...new Set([event, ...scopes.filter(members => members.includes(event)).flat()])];
    if (joined.length > 3) return null;
    scopes = scopes.filter(members => !members.includes(event));
    scopes.push(joined.filter(member => member !== event));
  }
  const total = logMass(order, tables, new Map());
  const chance = legs => Math.exp(logMass(order, tables, new Map(legs)) - total);
  const tenths = value => Math.round(value * 1000);
  const yes = Array.from({ length: events }, (_, event) => chance([[event, true]]));
  const result = new Map();
  for (const [a, b] of pairs) {
    const jointValue = tenths(chance([[a, true], [b, true]])), independent = tenths(yes[a] * yes[b]);
    result.set(`${a}-${b}`, { joint: jointValue, independent, difference: jointValue - independent });
  }
  return { marginals: yes.map(tenths), pairs: result };
}
