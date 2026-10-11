export const RELEASE_RULE: string;
export type SettlementSource = { method: string; request: 'GET' | 'JSON-RPC'; urls: string[] };
export function settlementSources(manifest: unknown): (SettlementSource | null)[];
