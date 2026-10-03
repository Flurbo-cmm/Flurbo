import { MobileAccount } from './account';
// Browser rendering is layout QA only. It must never create a native test wallet.
export const account = new MobileAccount({ get: async () => null, set: async () => {}, remove: async () => {} }, {
  createCredential: async () => { throw new Error('Use the native build'); },
  getCredential: async () => { throw new Error('Use the native build'); },
});
