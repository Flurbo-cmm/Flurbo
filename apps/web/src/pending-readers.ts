// Saved transactions the market pages track across reloads. Readers only: the pages own writing and clearing.
export type OraclePending = { hash: string; chainId: number; action: string; owner: string; market: string };
export type HybridPending = { hash: string | null; owner: string; id: string; action: string; chainId: number;
  approvalSelection?: string; claim?: { scope: number; mask: string } };
export const oraclePendingKey = 'flurbo.oracle.pending.v1';
export const hybridPendingKey = 'flurbo.hybrid.pending.v1';
export type ConditionalPending = { hash: string | null; owner: string; pool: string; action: string; chainId: number; selection?: string };
export const conditionalPendingKey = 'flurbo.conditional.pending.v1';

export const readOraclePending = (): OraclePending | null => {
  try {
    const value = JSON.parse(sessionStorage.getItem(oraclePendingKey) || 'null');
    return /^0x[0-9a-f]{64}$/i.test(value?.hash) && [11155111, 10143].includes(value?.chainId) ? value : null;
  } catch { return null; }
};

export const readHybridPending = (): HybridPending | null => {
  try {
    const item = JSON.parse(sessionStorage.getItem(hybridPendingKey) || 'null');
    return (item?.hash === null || /^0x[0-9a-f]{64}$/i.test(item?.hash))
      && /^0x[0-9a-f]{40}$/i.test(item?.owner)
      && typeof item.id === 'string' && [10143,11155111].includes(item.chainId)
      && (item.claim === undefined || (Number.isInteger(item.claim?.scope) && /^[1-9]\d{0,2}$/.test(item.claim?.mask))) ? item : null;
  } catch { return null; }
};

export const readConditionalPending = (): ConditionalPending | null => {
  try {
    const item = JSON.parse(sessionStorage.getItem(conditionalPendingKey) || 'null');
    return (item?.hash === null || /^0x[0-9a-f]{64}$/i.test(item?.hash)) && /^0x[0-9a-f]{40}$/i.test(item?.owner)
      && /^0x[0-9a-f]{40}$/i.test(item?.pool) && item.chainId === 10143 && typeof item.action === 'string' ? item : null;
  } catch { return null; }
};

export const pilotPendingNamespaces = () => {
  try {
    return Object.keys(localStorage).flatMap((key) => {
      const match = key.match(/^flurbo\.(pilot|practice-[0-9a-f]{40})\.pending\.v1$/);
      return match ? [match[1]] : [];
    });
  } catch { return []; }
};
