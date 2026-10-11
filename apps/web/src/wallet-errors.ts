// Wallets and libraries wrap a user cancel in different shapes, so look through the usual nesting before deciding.
const rejectedCodes = new Set<unknown>([4001, '4001', 'ACTION_REJECTED']);
const rejectedMessage = /user (rejected|denied|cancel+ed)|(rejected|denied|cancel+ed) by (the )?user/i;

export function walletRejected(error: unknown): boolean {
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number): boolean => {
    if (!value || typeof value !== 'object' || seen.has(value) || depth > 4) return false;
    seen.add(value);
    const item = value as { code?: unknown; message?: unknown; data?: unknown; error?: unknown; cause?: unknown; originalError?: unknown };
    if (rejectedCodes.has(item.code)) return true;
    if (typeof item.message === 'string' && rejectedMessage.test(item.message)) return true;
    return [item.data, item.error, item.cause, item.originalError].some(next => visit(next, depth + 1));
  };
  return visit(error, 0);
}
