export type PoolWebEdge = { a: number; b: number; joint: number | null; independent: number | null; difference: number | null; scope: number };
export type PoolWebNode = { event: number; yes: number | null };
export type PoolWeb = { nodes: PoolWebNode[]; edges: PoolWebEdge[] };
export type PairValues = { joint: number; independent: number } | null;
export function poolWeb(input: { events: number; factors: { scope: number; values: (string | bigint)[] }[];
  marginals: (number | null)[]; joint: (a: number, b: number) => PairValues }): PoolWeb;
export function strongestLinks(web: PoolWeb, event: number, limit?: number):
  { other: number; difference: number | null; edge: PoolWebEdge }[];
export function estimatePairs(state: { events: number; liquidity: string | bigint; factors: { scope: number; values: (string | bigint)[] }[] },
  pairs: [number, number][]): { marginals: number[]; pairs: Map<string, { joint: number; independent: number; difference: number }> } | null;
