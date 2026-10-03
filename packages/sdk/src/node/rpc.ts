import {scheduledRpcFetch} from '../request-scheduler.ts';
import { FlurboError } from '../errors.ts';

// JSON-RPC over HTTP to the operator's own chain endpoint. Provider error text can contain endpoint
// details or keys, so it is never surfaced: callers get a code and a safe message.
export type Rpc = (method: string, params?: unknown[]) => Promise<any>;
export type RpcOptions = { timeoutMs?: number; fetch?: typeof fetch };

export class RpcError extends FlurboError {
  readonly rpcCode: number | null;
  readonly kind: 'rejected' | 'unavailable' | 'timeout';
  constructor(kind: 'rejected' | 'unavailable' | 'timeout', rpcCode: number | null, message: string) {
    super(kind === 'timeout' ? 'timeout' : 'network', message);
    this.kind = kind; this.rpcCode = rpcCode;
  }
}

export function jsonRpc(url: string, options: RpcOptions = {}): Rpc {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new FlurboError('invalid_input', 'The RPC URL must use HTTP or HTTPS.');
  if (parsed.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) throw new FlurboError('invalid_input', 'Plain HTTP is only allowed for a local chain.');
  const request = options.fetch ?? scheduledRpcFetch, timeoutMs = options.timeoutMs ?? 15_000;
  let id = 0;
  return async (method, params = []) => {
    const callId = ++id;
    let response: Response;
    try {
      response = await request(url, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: callId, method, params }), signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      if ((e as Error)?.name === 'TimeoutError') throw new RpcError('timeout', null, `The chain did not answer ${method} in time.`);
      throw new RpcError('unavailable', null, `The chain endpoint could not be reached for ${method}.`);
    }
    let body: any;
    try { body = await response.json(); } catch { throw new RpcError('unavailable', null, `The chain endpoint returned an unreadable answer to ${method}.`); }
    if (body?.error) throw new RpcError('rejected', Number.isInteger(body.error.code) ? body.error.code : null, `The chain rejected ${method}.`);
    if (!response.ok || body?.id !== callId || !Object.hasOwn(body ?? {}, 'result')) throw new RpcError('unavailable', null, `The chain endpoint failed ${method}.`);
    return body.result;
  };
}

export const toHex = (n: bigint | number) => '0x' + BigInt(n).toString(16);
