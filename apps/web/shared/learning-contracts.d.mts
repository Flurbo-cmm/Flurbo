import type { Abi, AbiParameter, Hex } from 'viem';
export const poolAbi: Abi;
export const cashAbi: Abi;
export const engineAbi: Abi;
export const updateParameters: readonly AbiParameter[];
export const learningDeployment: {
  pool: Hex; cash: Hex; updater: Hex; pricing_engine: Hex; base_token_factory: Hex;
  chain_id: number; closes_at: number; verified_block: number; verified_block_hash: Hex;
  runtime_evidence: Record<string, { runtime_sha256: string }>;
};
