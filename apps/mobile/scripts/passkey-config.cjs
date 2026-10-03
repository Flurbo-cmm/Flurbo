const { isIP } = require('node:net');

function readRpId(env) {
  const value = env.FLURBO_PASSKEY_RP_ID;
  if (value === undefined) return undefined;
  const labels = value.split('.');
  if (value.length > 253 || labels.length < 2 || isIP(value) ||
      !/[a-z]/.test(labels.at(-1)) ||
      labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
      /\.(localhost|local|test|invalid)$/.test(value)) {
    throw new Error('FLURBO_PASSKEY_RP_ID must be a lowercase public DNS host, without a scheme, port or path.');
  }
  return value;
}

function association(platform, config, env) {
  const rpId = readRpId(env);
  if (!rpId) throw new Error('Set FLURBO_PASSKEY_RP_ID to the stable host you control first.');
  if (platform === 'android') {
    const packageName = config.android?.package;
    if (!/^[a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z][a-zA-Z0-9_]*)+$/.test(packageName ?? '')) {
      throw new Error('Configure android.package in app.json first.');
    }
    const fingerprints = (env.FLURBO_ANDROID_CERT_SHA256 ?? '').split(',').map(x => x.trim().toUpperCase());
    if (fingerprints.some(x => !/^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(x))) {
      throw new Error('FLURBO_ANDROID_CERT_SHA256 must contain comma-separated SHA-256 signing certificate fingerprints.');
    }
    return { rpId, filename: 'assetlinks.json', body: [{
      relation: ['delegate_permission/common.handle_all_urls', 'delegate_permission/common.get_login_creds'],
      target: { namespace: 'android_app', package_name: packageName,
        sha256_cert_fingerprints: [...new Set(fingerprints)] },
    }] };
  }
  if (platform === 'ios') {
    const prefix = env.FLURBO_IOS_APP_ID_PREFIX;
    const bundle = config.ios?.bundleIdentifier;
    if (!/^[A-Z0-9]{10}$/.test(prefix ?? '') ||
        !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(bundle ?? '')) {
      throw new Error('Set FLURBO_IOS_APP_ID_PREFIX to the Apple application identifier prefix and configure ios.bundleIdentifier.');
    }
    return { rpId, filename: 'apple-app-site-association', body: {
      webcredentials: { apps: [`${prefix}.${bundle}`] },
    } };
  }
  throw new Error('Choose android or ios.');
}

module.exports = { readRpId, association };
