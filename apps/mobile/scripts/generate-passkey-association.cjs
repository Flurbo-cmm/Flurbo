const { mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { association } = require('./passkey-config.cjs');
const { expo } = require('../app.json');

try {
  const platform = process.argv[2];
  if (process.argv.length !== 3) throw new Error('Usage: npm run passkeys:association -- android|ios');
  const { rpId, filename, body } = association(platform, expo, process.env);
  const directory = path.resolve(__dirname, '../dist-passkeys', rpId, platform, '.well-known');
  mkdirSync(directory, { recursive: true });
  const output = path.join(directory, filename);
  writeFileSync(output, JSON.stringify(body, null, 2) + '\n', 'utf8');
  console.log(`Generated ${output}\nPublish at https://${rpId}/.well-known/${filename}`);
  console.log('Generated locally only; domain ownership, signing identity and native authentication are not verified.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
