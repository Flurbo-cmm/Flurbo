import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { androidAssetLinks } from '../server/native-association.mjs';
test('Android credential association only accepts explicit public certificate fingerprints', () => {
  assert.equal(androidAssetLinks({ FLURBO_ANDROID_CERT_SHA256: '' }), null);
  assert.equal(androidAssetLinks({})[0].target.sha256_cert_fingerprints.length, 1);
  for (const value of ['placeholder', 'AA:BB', 'https://somewhere', 'aa'.repeat(32)]) assert.throws(() => androidAssetLinks({ FLURBO_ANDROID_CERT_SHA256: value }));
  const fingerprint = Array(32).fill('AB').join(':');
  const result = androidAssetLinks({ FLURBO_ANDROID_CERT_SHA256: fingerprint.toLowerCase() + ',' + fingerprint });
  const app = JSON.parse(readFileSync(new URL('../../mobile/app.json', import.meta.url), 'utf8'));
  assert.equal(result[0].target.package_name, app.expo.android.package);
  assert.deepEqual(result[0].target.sha256_cert_fingerprints, [fingerprint]);
  assert.deepEqual(result[0].relation, ['delegate_permission/common.handle_all_urls', 'delegate_permission/common.get_login_creds']);
});
