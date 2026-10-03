import test from 'node:test';
import assert from 'node:assert/strict';
import { passkeyErrorMessage } from './passkey-errors.ts';
test('native passkey causes are actionable without disclosing payloads', () => {
  for (const [error, match] of [['NoCredentials', /Google account/], ['UserCancelled', /cancelled/], ['TimedOut', /timed out/], ['BadConfiguration', /BadConfiguration/]]) {
    assert.match(passkeyErrorMessage({ code: 'PASSKEY_OPERATION_FAILED', cause: { error, message: 'secret payload' } }), match as RegExp);
  }
  assert.match(passkeyErrorMessage({ cause: { error: 'RequestFailed', message: 'RP ID cannot be validated.' } }), /DOMAIN_ASSOCIATION/);
  assert.doesNotMatch(passkeyErrorMessage({ message: 'secret payload' }), /secret payload|must be linked/);
});
