const { withAndroidManifest, withStringsXml, AndroidConfig } = require('expo/config-plugins');
const { readRpId } = require('../scripts/passkey-config.cjs');

function withPasskeyAssociation(config, { rpId } = {}) {
  const host = readRpId({ FLURBO_PASSKEY_RP_ID: rpId });
  if (!host) throw new Error('A passkey host is required for Android association');
  config = withAndroidManifest(config, mod => {
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(mod.modResults);
    app['meta-data'] = (app['meta-data'] || []).filter(item => item.$['android:name'] !== 'asset_statements');
    app['meta-data'].push({ $: { 'android:name': 'asset_statements', 'android:resource': '@string/asset_statements' } });
    return mod;
  });
  return withStringsXml(config, mod => {
    mod.modResults = AndroidConfig.Strings.setStringItem([{ $: { name: 'asset_statements', translatable: 'false' },
      _: JSON.stringify([{ relation: ['delegate_permission/common.get_login_creds'],
        // Expo deliberately skips escaping for translatable=false resources.
        target: { namespace: 'web', site: `https://${host}` } }]).replaceAll('"', '\\"'),
    }], mod.modResults);
    return mod;
  });
}
module.exports = withPasskeyAssociation;
