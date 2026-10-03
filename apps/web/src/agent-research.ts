// A research section for this agent's own markets, ready to paste into flurbo-agent.json. Every question needs at
// least one readable page in each cycle, or the runtime abstains (no_sources, missing_event_evidence).
export function researchBlock(markets: string[], sources: Record<string, (string | null)[]>, counts: Record<string, number>) {
  const hosts = new Set(['github.com']);
  for (const ns of markets) for (const url of sources[ns] ?? []) { try { const u = new URL(url ?? ''); if (u.protocol === 'https:') hosts.add(u.hostname); } catch { /* not a page */ } }
  const requirements = Object.fromEntries(markets.map(ns => [ns, Array.from({ length: counts[ns] ?? 2 }, (_, event) => ({ event, freshness: 'background' }))]));
  return `"research": ${JSON.stringify({
    provider: { kind: 'anthropic', model: 'PUT-THE-MODEL-NAME-HERE', apiKeyEnv: 'ANTHROPIC_API_KEY' },
    retriever: { kind: 'http', allowHosts: [...hosts], extraSources: Object.fromEntries(markets.map(ns => [ns, []])) },
    evidenceRequirements: requirements, perCycle: 2, perHour: 20, maxEvidenceAgeDays: 14,
  }, null, 2)},`;
}
