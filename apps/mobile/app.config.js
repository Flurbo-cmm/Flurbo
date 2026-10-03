const { readRpId } = require('./scripts/passkey-config.cjs');

module.exports = ({ config }) => {
  const rpId = readRpId(process.env);
  return {
    ...config,
    plugins: [...(config.plugins ?? []), 'expo-secure-store',
      ...(rpId ? [['./plugins/with-passkey-association.cjs', { rpId }]] : [])],
    // A configured host is not evidence that passkeys or PRF work on a device.
    extra: { ...config.extra, ...(rpId ? { passkeyRpId: rpId } : {}) },
    ios: {
      ...config.ios,
      ...(rpId ? { associatedDomains: [...new Set([
        ...(config.ios?.associatedDomains ?? []), `webcredentials:${rpId}`,
      ])] } : {}),
    },
    // Browser rendering is an opt-in layout check, separate from native exports.
    platforms: process.env.FLURBO_WEB_PREVIEW === '1'
      ? ['ios', 'android', 'web']
      : ['ios', 'android'],
  };
};
