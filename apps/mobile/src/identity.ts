import { createSecp256k1SigningSession, getEvmAddress } from '@category-labs/mera';
import { HDKey, HARDENED_OFFSET } from '@scure/bip32';
import { entropyToMnemonic, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

// Account identity: exactly the website's Mera BIP-39 / BIP-44 index-zero recipe.
// Never change this path or the PRF parameters as a cosmetic app update.
export function deriveAccount(prfOutput: Uint8Array) {
  if (prfOutput.length !== 32) throw new Error('Invalid account entropy');
  let seed: Uint8Array | undefined;
  let node: HDKey | undefined;
  let key: Uint8Array | null = null;
  let session: ReturnType<typeof createSecp256k1SigningSession> | undefined;
  try {
    seed = mnemonicToSeedSync(entropyToMnemonic(prfOutput, wordlist));
    node = HDKey.fromMasterSeed(seed);
    for (const index of [44 + HARDENED_OFFSET, 60 + HARDENED_OFFSET, HARDENED_OFFSET, 0, 0]) {
      const child: HDKey = node!.deriveChild(index);
      node!.wipePrivateData();
      node = child;
    }
    key = node!.privateKey;
    if (!key) throw new Error('Account derivation failed');
    session = createSecp256k1SigningSession({ privateKey: key });
    return { session, address: getEvmAddress(session.publicKey).toLowerCase() };
  } catch (error) {
    session?.end();
    throw error;
  } finally {
    key?.fill(0);
    node?.wipePrivateData();
    seed?.fill(0);
  }
}
