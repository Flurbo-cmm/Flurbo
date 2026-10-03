import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const digest = value => createHash('sha256').update(value).digest('hex');
export const SCENARIOS = ['stationary', 'regime_change', 'noisy', 'poison_recovery', 'higher_order'];
export const MODELS = ['pairwise_all', 'pairwise_singles', 'independent_all', 'uniform'];
const SEEDS = [7, 19, 41];
const HEADER = 'scenario,seed,step,model,mse_all_claims,kl_joint,p_ab,p_abc';

// Accept only the complete, fixed experiment emitted by the existing Rust runner.
// Missing failure scenarios, duplicate rows and partial output are not results.
export function parseComparison(csv) {
  const lines = csv.trim().split(/\r?\n/);
  if (Buffer.byteLength(csv) > 512_000 || lines.shift() !== HEADER || lines.length !== 2460) throw new Error('Incomplete comparison');
  let cursor = 0;
  const summaries = [];
  for (const scenario of SCENARIOS) {
    const groups = Object.fromEntries(MODELS.map(model => [model, { initial: [], final: [], kl: [] }]));
    for (const seed of SEEDS) for (let step = 0; step <= 4000; step += 100) for (const model of MODELS) {
      const fields = lines[cursor++].split(',');
      if (fields.length !== 8 || fields[0] !== scenario || fields[1] !== String(seed) || fields[2] !== String(step) || fields[3] !== model ||
          fields.slice(4).some(value => !/^\d+\.\d{10}$/.test(value))) throw new Error('Invalid comparison row');
      const [mse, kl, ab, abc] = fields.slice(4).map(Number);
      if (![mse, kl, ab, abc].every(Number.isFinite) || mse > 1 || ab > 1 || abc > ab) throw new Error('Invalid comparison metric');
      if (step === 0) groups[model].initial.push(mse);
      if (step === 4000) { groups[model].final.push(mse); groups[model].kl.push(kl); }
    }
    const mean = values => values.reduce((sum, value) => sum + value, 0) / SEEDS.length;
    for (const model of MODELS) {
      const group = groups[model];
      summaries.push({ scenario, model, initialMse: mean(group.initial), finalMse: mean(group.final),
        finalMseMin: Math.min(...group.final), finalMseMax: Math.max(...group.final), finalKl: mean(group.kl) });
    }
  }
  return { schema: 'flurbo.learning-comparison.v1', engine: 'flurbo-core / Rust', suite: 'parlay_compare synthetic v1',
    input: 'synthetic', changesExecutablePrices: false, events: 3, seeds: SEEDS, steps: 4000, observations: cursor,
    summaries, outputSha256: digest(csv) };
}

export async function runComparison({ binary = fileURLToPath(new URL('../../../bin/flurbo-parlay-compare', import.meta.url)),
  commit = process.env.RENDER_GIT_COMMIT, signal } = {}) {
  // A fixed executable and fixed argument, never an HTTP-supplied command or file.
  // The child receives no hosting credentials, wallet material or RPC endpoint.
  const { stdout } = await execute(binary, ['synthetic'], { timeout: 60_000, maxBuffer: 512_000, signal,
    windowsHide: true, encoding: 'utf8', env: process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {} });
  const report = parseComparison(stdout);
  return { ...report, generatedAt: new Date().toISOString(), binarySha256: digest(await readFile(binary)),
    sourceCommit: /^[a-f0-9]{40,64}$/i.test(commit || '') ? commit : null };
}
