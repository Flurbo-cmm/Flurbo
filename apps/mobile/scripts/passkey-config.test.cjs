const assert = require('node:assert/strict');
const test = require('node:test');
const { association, readRpId } = require('./passkey-config.cjs');
const appConfig = require('../app.config.js');
const { expo } = require('../app.json');
const host = { FLURBO_PASSKEY_RP_ID: 'accounts.example.com' };
const fingerprint = Array(32).fill('AB').join(':');

test('host is optional for preview but required for association generation', () => {
  assert.equal(readRpId({}), undefined);
  assert.throws(() => association('android', expo, {}), /stable host/);
});

test('rejects URLs, paths, IPs, malformed labels and local hosts', () => {
  for (const value of ['', 'https://example.com', 'example.com/path', 'example.com:443',
    '../example.com', 'example.com?x=y', 'EXAMPLE.com', ' example.com', 'example.com.',
    '127.0.0.1', 'localhost', 'app.local', 'app.invalid', '-app.example.com',
    'app..com', `${'a'.repeat(64)}.com`]) {
    assert.throws(() => readRpId({ FLURBO_PASSKEY_RP_ID: value }), /DNS host/);
  }
});

test('Android binds the configured package to explicit signing certificates', () => {
  const result = association('android', expo, { ...host,
    FLURBO_ANDROID_CERT_SHA256: `${fingerprint.toLowerCase()},${fingerprint}` });
  assert.equal(result.filename, 'assetlinks.json');
  assert.equal(result.body[0].target.package_name, expo.android.package);
  assert.deepEqual(result.body[0].target.sha256_cert_fingerprints, [fingerprint]);
  for (const value of [undefined, '', 'SHA256_FINGERPRINT', fingerprint.slice(3), `${fingerprint},`]) {
    assert.throws(() => association('android', expo, { ...host, FLURBO_ANDROID_CERT_SHA256: value }), /fingerprints/);
  }
});

test('iOS uses the application identifier prefix and configured bundle', () => {
  const result = association('ios', expo, { ...host, FLURBO_IOS_APP_ID_PREFIX: 'ABCDE12345' });
  assert.equal(result.filename, 'apple-app-site-association');
  assert.deepEqual(result.body, { webcredentials: { apps: [`ABCDE12345.${expo.ios.bundleIdentifier}`] } });
  assert.throws(() => association('ios', expo, host), /identifier prefix/);
  assert.throws(() => association('web', expo, host), /android or ios/);
});

test('Expo adds only the chosen host and preserves existing app configuration', () => {
  const previous = process.env.FLURBO_PASSKEY_RP_ID;
  try {
    delete process.env.FLURBO_PASSKEY_RP_ID;
    assert.equal(appConfig({ config: expo }).extra.passkeyRpId, undefined);
    assert.equal(appConfig({ config: expo }).ios.associatedDomains, undefined);
    process.env.FLURBO_PASSKEY_RP_ID = host.FLURBO_PASSKEY_RP_ID;
    const config = appConfig({ config: { ...expo, extra: { retained: true },
      ios: { ...expo.ios, associatedDomains: ['applinks:existing.example.com'] } } });
    assert.equal(config.extra.retained, true);
    assert.equal(config.extra.passkeyRpId, host.FLURBO_PASSKEY_RP_ID);
    assert.equal(config.ios.bundleIdentifier, expo.ios.bundleIdentifier);
    assert.deepEqual(config.ios.associatedDomains,
      ['applinks:existing.example.com', 'webcredentials:accounts.example.com']);
    process.env.FLURBO_PASSKEY_RP_ID = 'https://example.com';
    assert.throws(() => appConfig({ config: expo }), /DNS host/);
  } finally {
    if (previous === undefined) delete process.env.FLURBO_PASSKEY_RP_ID;
    else process.env.FLURBO_PASSKEY_RP_ID = previous;
  }
});
