import * as SecureStore from 'expo-secure-store';
import { reactNativeWebAuthnClient } from '@category-labs/mera/react-native-webauthn-client';
import { ACCOUNT_KEY, MobileAccount } from './account';

export const account = new MobileAccount({
  get: () => SecureStore.getItemAsync(ACCOUNT_KEY),
  set: value => SecureStore.setItemAsync(ACCOUNT_KEY, value, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }),
  remove: () => SecureStore.deleteItemAsync(ACCOUNT_KEY),
}, reactNativeWebAuthnClient);
