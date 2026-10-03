// One command for cross-language conformance: every SDK runs the same golden fixtures in protocol/fixtures.
//   node protocol/tools/conformance.mjs          fixtures in TypeScript, Python, Rust and C++
//   node protocol/tools/conformance.mjs --full   also every unit and local-chain suite (needs anvil and a forge build)
// A language whose toolchain is missing fails the run; nothing is skipped silently.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const full = process.argv.includes('--full');
const windows = process.platform === 'win32';
const exe = windows ? '.exe' : '';

const env = { ...process.env };
// MSYS2 UCRT64 provides GCC, make and OpenSSL on Windows.
if (windows && existsSync('C:\\msys64\\ucrt64\\bin')) env.PATH = `C:\\msys64\\ucrt64\\bin${delimiter}${env.PATH}`;

const found = (cmd, args = ['--version']) => spawnSync(cmd, args, { env, stdio: 'ignore', shell: false }).status === 0;
const python = [join(root, 'packages/sdk-python/.venv', windows ? 'Scripts/python.exe' : 'bin/python'), 'python3', 'python'].find(p => p.includes('.venv') ? existsSync(p) : found(p));
const make = ['make', 'mingw32-make'].find(m => found(m));

const cpp = join(root, 'packages/sdk-cpp');
const steps = [
  { language: 'protocol', name: 'schemas and fixtures regenerate identically from the TypeScript reference', cwd: root, runs: [
    ['node', ['protocol/tools/generate-schemas.mjs', '--check']], ['node', ['protocol/tools/generate-fixtures.mjs', '--check']]] },
  { language: 'typescript', name: 'fixtures', cwd: join(root, 'packages/sdk'), runs: [['node', ['--test', 'test/protocol-fixtures.test.ts']]] },
  { language: 'python', name: 'fixtures', cwd: join(root, 'packages/sdk-python'), needs: python && 'Python 3.11 (packages/sdk-python/.venv or python on PATH)',
    runs: [[python, ['-m', 'unittest', 'tests.test_conformance']]] },
  { language: 'rust', name: 'fixtures', cwd: join(root, 'packages/sdk-rust'), needs: found('cargo') && 'cargo', runs: [['cargo', ['test', '--quiet', '--test', 'conformance']]] },
  { language: 'cpp', name: 'fixtures', cwd: cpp, needs: make && found('g++') && 'GNU make, g++ and OpenSSL', runs: [
    [make, [`build/test_conformance${exe}`]], [join(cpp, `build/test_conformance${exe}`), []]] },
];
if (full) steps.push(
  { language: 'typescript', name: 'every suite, including the local chain', cwd: join(root, 'packages/sdk'), runs: [['node', ['--test', ...readdirSync(join(root, 'packages/sdk/test')).filter(f => f.endsWith('.test.ts')).map(f => `test/${f}`)]]] },
  { language: 'python', name: 'every suite, including the local chain', cwd: join(root, 'packages/sdk-python'), needs: python && 'Python', runs: [[python, ['-m', 'unittest', 'discover', '-s', 'tests']]] },
  { language: 'rust', name: 'every suite, including the local chain', cwd: join(root, 'packages/sdk-rust'), needs: found('cargo') && 'cargo', runs: [['cargo', ['test', '--quiet']]] },
  { language: 'cpp', name: 'every suite, including the local chain', cwd: cpp, needs: make && 'GNU make', runs: [[make, ['test']], [make, ['test-chain']]] },
);

let failed = 0;
// The local-chain suites skip themselves without anvil or the forge build; --full requires both instead.
if (full && !(found('anvil') && existsSync(join(root, 'target/foundry/out/PilotPool.sol')))) {
  console.log('FAIL  --full needs anvil on PATH and the contracts built with forge build (target/foundry/out).');
  process.exit(1);
}
for (const step of steps) {
  const label = `${step.language.padEnd(10)} ${step.name}`;
  if ('needs' in step && !step.needs) {
    failed++;
    console.log(`FAIL  ${label}: toolchain not found`);
    continue;
  }
  let error = null;
  for (const [cmd, args] of step.runs) {
    const r = spawnSync(cmd, args, { cwd: step.cwd, env, encoding: 'utf8', shell: false, maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) {
      error = `${[cmd, ...args].join(' ')} exited ${r.status ?? r.error?.message}\n${`${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').slice(-25).join('\n')}`;
      break;
    }
  }
  if (error) failed++;
  console.log(`${error ? 'FAIL' : 'ok  '}  ${label}${error ? `\n${error.replace(/^/gm, '      ')}` : ''}`);
}
console.log(failed ? `${failed} step(s) failed.` : `All ${steps.length} steps passed.`);
process.exit(failed ? 1 : 0);
