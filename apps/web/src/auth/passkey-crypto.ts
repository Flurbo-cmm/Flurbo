import {
  createPasskeyWithPrfOutput, getPasskeyPrfOutput, createSecp256k1SigningSession, getEvmAddress,
  type Secp256k1SigningSession,
} from "@category-labs/mera";
import { HDKey, HARDENED_OFFSET } from "@scure/bip32";
import { entropyToMnemonic, mnemonicToSeedSync } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { hashMessage, hexToBytes, bytesToHex, serializeSignature, type Hex } from 'viem';

// Key derivation and passkey calls, loaded only when someone signs in or creates an account.
export { createPasskeyWithPrfOutput, getPasskeyPrfOutput };

// Matches Mera's documented BIP-39 / BIP-44 EVM account recipe, index 0.
// These derivation choices are part of account identity and must not change silently.
export function deriveAccount(prfOutput: Uint8Array) {
  if (prfOutput.length !== 32) throw new Error("Invalid account entropy");
  let seed: Uint8Array | undefined;
  let node: HDKey | undefined;
  let key: Uint8Array | null = null;
  let session: Secp256k1SigningSession | undefined;
  try {
    seed = mnemonicToSeedSync(entropyToMnemonic(prfOutput, wordlist));
    node = HDKey.fromMasterSeed(seed);
    for (const index of [44 + HARDENED_OFFSET, 60 + HARDENED_OFFSET, HARDENED_OFFSET, 0, 0]) {
      const child: HDKey = node!.deriveChild(index);
      node!.wipePrivateData();
      node = child;
    }
    key = node!.privateKey;
    if (!key) throw new Error("Account derivation failed");
    session = createSecp256k1SigningSession({ privateKey: key });
    return { session, address: getEvmAddress(session.publicKey) };
  } catch (error) {
    session?.end();
    throw error;
  } finally {
    key?.fill(0);
    node?.wipePrivateData();
    seed?.fill(0);
  }
}

// Signs the server's login challenge as an EIP-191 message.
export async function signLoginChallenge(session: Secp256k1SigningSession, message: string): Promise<Hex> {
  const signature = await session.signDigest(hexToBytes(hashMessage(message)));
  return serializeSignature({ r: bytesToHex(signature.compact.slice(0, 32)), s: bytesToHex(signature.compact.slice(32)), yParity: signature.recovery });
}
