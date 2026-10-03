import { getRandomValues, digest, CryptoDigestAlgorithm } from 'expo-crypto';
import { installAbortHelpers } from './abort-helpers';

installAbortHelpers(AbortSignal, AbortController);

// Required before future Mera imports on Hermes; no account keys are created here.
if (typeof globalThis.crypto?.getRandomValues !== 'function') {
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: { ...globalThis.crypto, getRandomValues },
  });
}
// The shared deployment verifier needs SHA-256, not key-generation APIs.
if (!globalThis.crypto?.subtle?.digest) {
  Object.defineProperty(globalThis.crypto, 'subtle', { configurable: true, value: {
    async digest(algorithm: string | { name: string }, input: ArrayBuffer | ArrayBufferView) {
      if ((typeof algorithm === 'string' ? algorithm : algorithm.name).toUpperCase() !== 'SHA-256') throw new Error('Unsupported digest algorithm');
      const bytes = ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : new Uint8Array(input);
      return digest(CryptoDigestAlgorithm.SHA256, new Uint8Array(bytes));
    },
  } });
}
