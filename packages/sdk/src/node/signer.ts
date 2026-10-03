import { privateKeyToAccount } from 'viem/accounts';
import { keccak256 as viemKeccak } from 'viem';
import { FlurboError } from '../errors.ts';

// The only place a transaction is signed. Keys stay in the operator's runtime: never sent to Flurbo,
// never logged, never placed in a model prompt. A signer signs exactly what it is given; every limit is
// checked before it is called. Remote signers (a KMS or a signing service) implement the same interface.
export type UnsignedTransaction = { chainId: number; nonce: number; to: string; data: string; value: bigint; gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
export interface Signer {
  readonly address: string;
  readonly kind: string;
  signTransaction(tx: UnsignedTransaction): Promise<string>;
  signMessage(message: string): Promise<string>;
}

export function localKeySigner(privateKey: string): Signer {
  if (typeof privateKey !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new FlurboError('invalid_input', 'The agent key must be 32 bytes of hex with a 0x prefix.');
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  return {
    address: account.address.toLowerCase(),
    kind: 'local-key',
    signTransaction: tx => account.signTransaction({ type: 'eip1559', chainId: tx.chainId, nonce: tx.nonce, to: tx.to as `0x${string}`, data: tx.data as `0x${string}`,
      value: tx.value, gas: tx.gas, maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas }),
    signMessage: message => account.signMessage({ message }),
  };
}

// Reads the key from an environment variable. The value is never echoed, even in errors.
export function signerFromEnv(variable: string, env: Record<string, string | undefined> = process.env): Signer {
  const value = env[variable];
  if (!value) throw new FlurboError('invalid_input', `Set ${variable} to the dedicated agent wallet key (testnet only). Never use a deployer, settlement, reviewer or personal wallet.`);
  return localKeySigner(value.trim());
}

export const transactionHash = (raw: string) => viemKeccak(raw as `0x${string}`);
export const keccak256 = (data: string) => viemKeccak(data as `0x${string}`);
