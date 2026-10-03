import { createClient, jointFromPair, jointToJSON, frechetBounds, parseDecimal, SCHEMAS, FlurboError } from '../../../packages/sdk/src/index.ts';
import { browserTransport } from '../../../packages/sdk/src/transport-browser.ts';
import { appFetch } from './platform-fetch.ts';

// Browser glue for the agent pages. The SDK client reuses the signed-in session cookie; nothing here reads
// or stores credentials. Every agent request goes through the same session and invite checks as the app.
export const agentClient = createClient({ transport: browserTransport({ fetch: appFetch as never }) });
export { FlurboError, frechetBounds };

export type ProfileJSON = { id: string; name: string; mode: 'paper' | 'approval'; status: 'active' | 'paused' | 'archived'; strategy: { id: string; version: string };
  market: { namespace: string; pool: string; title: string }; config: Record<string, string | number | boolean>; createdAt: number; updatedAt: number;
  kind?: 'runtime'; markets?: string[]; wallet?: string | null; walletHistory?: { address: string; from: number; until: number | null }[];
  runtimePolicy?: { version: number; paused: boolean; liveEnabled: boolean; limits: { maxTradeCostAtoms: string | null; windows: { seconds: number; atoms: string }[] } } };
export type ReviewJSON = { schema: string; action: string; amountAtoms: string; expiresAt: number; maximumFeeWei: string; requested: Record<string, unknown>;
  transaction: { from: `0x${string}`; to: `0x${string}`; data: `0x${string}`; value: `0x${string}`; chainId: `0x${string}` }; snapshot: { blockNumber: string; blockHash: string; timestamp: number } };
export type RecordJSON = { id: string; kind: 'decision' | 'paper' | 'proposal'; createdAt: number } & Record<string, any>;

// Percent text ("62.5") to exact parts per million, without floating point.
export function percentToPpm(text: string): bigint {
  const ppm = parseDecimal(text.trim(), 4);
  if (ppm > 1_000_000n) throw new FlurboError('invalid_forecast', 'Percentages cannot exceed 100.');
  return ppm;
}

export type EvidenceInput = { title: string; source: string; url: string; observedAt: string; note: string };
export function buildForecast(input: { pool: string; a: number; b: number; pA: string; pB: string; pBoth: string; evidence: EvidenceInput[];
  assumptions: string; uncertainty: string; explanation: string; confidence: '' | 'low' | 'medium' | 'high' }) {
  const joint = jointFromPair({ a: input.a, b: input.b, pA: percentToPpm(input.pA), pB: percentToPpm(input.pB), pBoth: percentToPpm(input.pBoth) });
  return {
    schema: SCHEMAS.forecast, pool: input.pool, joint: jointToJSON(joint),
    evidence: input.evidence.filter(e => e.title.trim()).map((e, i) => ({ id: `evidence-${i + 1}`, title: e.title, source: e.source, url: e.url.trim() || null,
      observedAt: new Date(e.observedAt).toISOString(), note: e.note })),
    assumptions: input.assumptions.split('\n').map(x => x.trim()).filter(Boolean).slice(0, 8),
    uncertainty: input.uncertainty, explanation: input.explanation, selfReportedConfidence: input.confidence || null,
    source: { kind: 'user', name: 'account' }, createdAt: new Date().toISOString(),
  };
}

export const message = (error: unknown) => (error instanceof Error ? error.message : 'Something went wrong. Nothing was traded.');

// Administration of agents that run on the user's own infrastructure. Same signed-in session and invite
// checks as every account route. Credentials are issued here and shown once; the browser never stores them.
async function call(path: string, body?: unknown): Promise<any> {
  const response = await appFetch(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const parsed = await response.json().catch(() => null);
  if (!response.ok) throw new FlurboError(response.status === 409 ? 'conflict' : response.status === 404 ? 'not_found' : response.status === 401 ? 'unauthenticated' : 'invalid_input',
    typeof parsed?.error === 'string' ? parsed.error : 'The request was rejected.');
  return parsed;
}
const agentPath = (id: string, rest = '') => `/api/agents/${encodeURIComponent(id)}${rest}`;
export const runtimeAdmin = {
  create: (name: string, markets: string[]) => call('/api/agents', { kind: 'runtime', name, markets }),
  get: (id: string) => call(agentPath(id)),
  issueCredential: (id: string, input: { scopes: string[]; ttlDays: number; label: string }) => call(agentPath(id, '/credentials'), input),
  revokeCredential: (id: string, credentialId: string) => call(agentPath(id, `/credentials/${credentialId}/revoke`), {}),
  rotateCredential: (id: string, credentialId: string) => call(agentPath(id, `/credentials/${credentialId}/rotate`), {}),
  walletChallenge: (id: string, wallet: string) => call(agentPath(id, '/wallet/challenge'), { wallet }),
  walletVerify: (id: string, challengeId: string, signature: string) => call(agentPath(id, '/wallet/verify'), { id: challengeId, signature }),
  setPolicy: (id: string, patch: Record<string, unknown>) => call(agentPath(id, '/runtime-policy'), patch),
  checkExecution: (id: string, hash: string) => call(agentPath(id, `/executions/${hash}/check`), {}),
  rename: (id: string, name: string) => call(agentPath(id, '/update'), { name }),
  archive: (id: string) => call(agentPath(id, '/delete'), {}),
};
