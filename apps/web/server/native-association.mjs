// These public fingerprints identify installed Android builds. They are not keys.
// Keep the package ID aligned with apps/mobile/app.json; changing it breaks login.
import association from '../../../config/mobile-passkeys.json' with { type: 'json' };
export function androidAssetLinks(env = process.env) {
  const raw = env.FLURBO_ANDROID_CERT_SHA256 ?? association.certificateSha256.join(',');
  if (!raw) return null;
  const fingerprints = [...new Set(raw.split(',').map(value => value.trim().toUpperCase()))];
  if (fingerprints.length > 8 || fingerprints.some(value => !/^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(value))) {
    throw new Error('Invalid Android SHA-256 certificate fingerprint');
  }
  // Android passkey RP validation requires handle_all_urls as well as the
  // credential-sharing relation. Checking get_login_creds alone is insufficient.
  return [{ relation: ['delegate_permission/common.handle_all_urls', 'delegate_permission/common.get_login_creds'], target: {
    namespace: 'android_app', package_name: association.androidPackage, sha256_cert_fingerprints: fingerprints,
  } }];
}
