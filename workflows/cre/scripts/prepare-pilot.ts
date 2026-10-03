import { preparePilot } from '../src/pilot-config';

const path = process.argv[2];
if (!path || process.argv.length !== 3) throw new Error('Usage: bun scripts/prepare-pilot.ts <reviewed-publication.json>');
const input = await Bun.file(path).json();
console.log(JSON.stringify(preparePilot(input, Math.floor(Date.now() / 1000)), null, 2));
