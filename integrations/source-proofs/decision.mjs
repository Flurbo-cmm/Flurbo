export function decideIntegerProof(verified, rule) {
  if (!verified || !rule || rule.schema !== 'flurbo.private-decision.v1'
    || verified.binding?.field !== rule.field || !/^(0|[1-9][0-9]*)$/.test(verified.value)
    || typeof rule.threshold !== 'string' || !/^(0|[1-9][0-9]*)$/.test(rule.threshold)
    || !['gt', 'gte', 'lt', 'lte', 'eq'].includes(rule.operator)) throw Error('Invalid private source decision');
  const value = BigInt(verified.value), threshold = BigInt(rule.threshold);
  const yes = rule.operator === 'gt' ? value > threshold : rule.operator === 'gte' ? value >= threshold
    : rule.operator === 'lt' ? value < threshold : rule.operator === 'lte' ? value <= threshold : value === threshold;
  return yes ? 2 : 1;
}
