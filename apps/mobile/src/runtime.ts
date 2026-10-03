import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { reactNativeWebAuthnClient } from '@category-labs/mera/react-native-webauthn-client';
import { AuthController } from '../../web/src/auth/controller';
import { setAppTransport } from '../../web/src/platform-fetch';
import { apiFetch, sessionTransport } from './api';
import { PublicStorage } from './public-storage';
import { passkeyErrorMessage } from './passkey-errors';
import { ACCOUNT_KEY, parseAccount } from './account';

export const storage = new PublicStorage((key, value) => value === null ? AsyncStorage.removeItem(key) : AsyncStorage.setItem(key, value));
export const auth = new AuthController({ policy: { rpId: 'flurbo.singu.online', local: false, reason: null },
  storage, client: reactNativeWebAuthnClient, transport: sessionTransport, errorMessage: passkeyErrorMessage });
export async function initialize() {
  const keys = (await AsyncStorage.getAllKeys()).filter(key => key.startsWith('flurbo.'));
  storage.hydrate(await AsyncStorage.multiGet(keys));
  const bookmark = parseAccount(await SecureStore.getItemAsync(ACCOUNT_KEY));
  const bookmarkKey = 'flurbo.passkey.v1:flurbo.singu.online';
  if (!storage.getItem(bookmarkKey) && bookmark) { storage.setItem(bookmarkKey, JSON.stringify(bookmark)); await storage.flush(); }
  // Narrow compatibility ports for shared public claim/checkout tracking helpers.
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage });
  setAppTransport(apiFetch);
  await auth.restore();
}
