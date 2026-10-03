export type FlurboErrorCode =
  | 'unauthenticated' | 'invite_required' | 'forbidden' | 'not_found' | 'invalid_input' | 'conflict'
  | 'unsupported_claim' | 'cross_pool' | 'market_closed' | 'quote_unavailable' | 'stale_quote'
  | 'invalid_forecast' | 'rate_limited' | 'timeout' | 'aborted' | 'network' | 'unavailable'
  | 'invalid_response' | 'provider_unavailable';

// Messages are safe to show. Upstream bodies, URLs and credentials are never embedded.
export class FlurboError extends Error {
  readonly code: FlurboErrorCode;
  readonly status: number | null;
  readonly retryAfterSeconds: number | null;
  constructor(code: FlurboErrorCode, message: string, options: { status?: number | null; retryAfterSeconds?: number | null } = {}) {
    super(message);
    this.name = 'FlurboError';
    this.code = code;
    this.status = options.status ?? null;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
  }
}

export const isFlurboError = (value: unknown): value is FlurboError => value instanceof FlurboError;
