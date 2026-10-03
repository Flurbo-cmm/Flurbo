import { FlurboError } from './errors.ts';
import { CHAIN_ID } from './version.ts';
import { isNamespace, type Namespace } from './market.ts';

// Protocol version 1 (protocol/README.md). A client sends the version on every headless request and
// rejects deployments, schemas and interfaces it does not recognise.
export const PROTOCOL_VERSION = '1';
export const PROTOCOL_HEADER = 'Flurbo-Agent-Protocol';
export const RUNTIME_API_BASE = '/api/agent-runtime/v1';
export const DEPLOYMENT_INTERFACE = 'flurbo.pilot-pool.v1';
export const COLLATERAL = '0xa9012a055bd4e0edff8ce09f960291c09d5322dc';
export const COLLATERAL_DECIMALS = 6;
export const SERVICE_LIMITS = Object.freeze({ maxQuantityAtoms: 100_000_000n, maxLimitAtoms: 100_000_000n, slippageBps: [10, 50, 100] as readonly number[], maxDeadlineSeconds: 300 });
export const SCOPES = ['markets:read', 'wallet:read', 'runtime:report', 'executions:report'] as const;
export type Scope = typeof SCOPES[number];
export const ERROR_CODES = ['UNAUTHENTICATED', 'CREDENTIAL_EXPIRED', 'CREDENTIAL_REVOKED', 'INVITE_REQUIRED', 'SCOPE_REQUIRED', 'AGENT_ARCHIVED', 'BROWSER_NOT_SUPPORTED',
  'RATE_LIMITED', 'UNSUPPORTED_PROTOCOL', 'UNSUPPORTED_DEPLOYMENT', 'INVALID_INPUT', 'NOT_FOUND', 'CONFLICT', 'HASH_CONFLICT', 'WALLET_REQUIRED',
  'TOO_MANY_PENDING', 'UNAVAILABLE'] as const;
export type RuntimeErrorCode = typeof ERROR_CODES[number];
// Credential problems after which a compliant runtime stops starting new actions.
export const STOP_CODES: readonly RuntimeErrorCode[] = ['UNAUTHENTICATED', 'CREDENTIAL_EXPIRED', 'CREDENTIAL_REVOKED', 'INVITE_REQUIRED', 'AGENT_ARCHIVED', 'SCOPE_REQUIRED'];

export type Deployment = {
  schema: 'flurbo.agent-deployment.v1'; interface: typeof DEPLOYMENT_INTERFACE; namespace: Namespace; chainId: number;
  pool: string; resolver: string; collateral: { address: string; decimals: number };
  codeHashes: { pool: string; resolver: string }; rulesHash: string; closesAt: number; eventCount: number;
  limits: { maxQuantityAtoms: string; maxLimitAtoms: string; slippageBps: number[]; maxDeadlineSeconds: number };
};
const bad = (what: string): never => { throw new FlurboError('invalid_response', `Unsupported deployment: ${what}.`); };
const addr = (v: unknown, what: string) => (typeof v === 'string' && /^0x[0-9a-f]{40}$/.test(v) ? v : bad(what));
const hash = (v: unknown, what: string) => (typeof v === 'string' && /^0x[0-9a-f]{64}$/.test(v) ? v : bad(what));

// Validates a deployment record and the service limits it states. Limits looser than the protocol's are
// refused rather than trusted.
export function parseDeployment(value: unknown): Deployment {
  const d = value as Record<string, any> | null;
  if (!d || typeof d !== 'object' || d.schema !== 'flurbo.agent-deployment.v1') bad('schema');
  if (d!.interface !== DEPLOYMENT_INTERFACE) bad('interface');
  if (d!.chainId !== CHAIN_ID) bad('chain');
  if (!isNamespace(d!.namespace)) bad('namespace');
  if (addr(d!.collateral?.address, 'collateral') !== COLLATERAL || d!.collateral.decimals !== COLLATERAL_DECIMALS) bad('collateral');
  if (!Number.isSafeInteger(d!.closesAt) || ![2, 3, 4].includes(d!.eventCount)) bad('market shape');
  const l = d!.limits;
  if (!l || l.maxQuantityAtoms !== '100000000' || l.maxLimitAtoms !== '100000000' || JSON.stringify(l.slippageBps) !== '[10,50,100]' || l.maxDeadlineSeconds !== 300) bad('service limits');
  return { schema: 'flurbo.agent-deployment.v1', interface: DEPLOYMENT_INTERFACE, namespace: d!.namespace, chainId: CHAIN_ID,
    pool: addr(d!.pool, 'pool'), resolver: addr(d!.resolver, 'resolver'), collateral: { address: COLLATERAL, decimals: COLLATERAL_DECIMALS },
    codeHashes: { pool: hash(d!.codeHashes?.pool, 'pool code hash'), resolver: hash(d!.codeHashes?.resolver, 'resolver code hash') },
    rulesHash: hash(d!.rulesHash, 'rules hash'), closesAt: d!.closesAt, eventCount: d!.eventCount,
    limits: { maxQuantityAtoms: '100000000', maxLimitAtoms: '100000000', slippageBps: [10, 50, 100], maxDeadlineSeconds: 300 } };
}

// Exact limit arithmetic (protocol/specs/numbers.md).
export const buyLimit = (quote: bigint, bps: number): bigint => (quote * BigInt(10_000 + bps) + 9_999n) / 10_000n;
export const sellMinimum = (quote: bigint, bps: number): bigint => quote * BigInt(10_000 - bps) / 10_000n;
