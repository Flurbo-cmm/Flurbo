export type LsFactor = { scope: number; values: (string | bigint)[] };
export type LsAnalyticsInput = { events: number; a: number; b: number; initialDepthAtoms: string | bigint; commissionBps: number;
  order: number[]; factors: LsFactor[] };
export type LsAnalyticsState = { events: number; a: number; b: number; liquidity: string; order: number[];
  factors: { scope: number; values: string[] }[] };
export const WAD: bigint;
export const LN2_WAD: bigint;
export const ATOM_TO_WAD: bigint;
export const MIN_COMMISSION_BPS: number;
export const MAX_COMMISSION_BPS: number;
export function depthRateWad(events: number, commissionBps: number): bigint;
export function depthWad(initialDepthWad: bigint, rateWad: bigint, factors: LsFactor[]): bigint;
export function lsAnalyticsState(input: LsAnalyticsInput): { state: LsAnalyticsState; depthWad: bigint; rateWad: bigint };
export function verifiedLsState(
  committed: { initialDepthAtoms: string; commissionBps: number; depthRateWad?: string },
  pool: { events: number; a: number; b: number; order: readonly number[]; factors: readonly LsFactor[];
    liquidity: bigint; commissionBps: number | bigint; depth: bigint },
): { state: LsAnalyticsState; ls: { initialDepthWad: bigint; rateWad: bigint } } | null;
