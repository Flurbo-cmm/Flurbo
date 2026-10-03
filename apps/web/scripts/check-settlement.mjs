import { readFile, mkdir, open, rename, unlink } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pilotRpc } from '../server/pilot.mjs';
import { checkSettlement, monitorIdentity } from '../server/settlement-monitor.mjs';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../../../', import.meta.url));
export async function writeAtomic(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    try { await file.writeFile(JSON.stringify(value, null, 2) + '\n'); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, path);
  }
  finally { await unlink(temporary).catch(() => {}); }
}

export async function runSettlementCheck({ args = process.argv.slice(2), env = process.env, request = fetch,
  output = console.log, directory = resolve(root, 'target/settlement-monitor'), now = () => Math.floor(Date.now() / 1000) } = {}) {
  if (args.length) {
    output(JSON.stringify({ status: 'check_failed', message: 'No arguments are supported.' })); return 2;
  }
  let releaseLock;
  try {
    const raw = env.FLURBO_PILOT_MANIFEST_JSON ?? await readFile(resolve(root, 'config/pilot-testnet.json'), 'utf8');
    const manifest = JSON.parse(raw);
    if (['rehearsal', 'ethereum-activity', 'deterministic-source-v1'].includes(manifest.publication?.mode)) throw new Error('Manifest mode mismatch');
    const key = createHash('sha256').update(monitorIdentity(manifest)).digest('hex');
    await mkdir(directory, { recursive: true });
    const lockPath = resolve(directory, `${key}.lock`);
    const lock = await open(lockPath, 'wx', 0o600);
    releaseLock = async () => { await lock.close(); await unlink(lockPath); };
    const checkpointPath = resolve(directory, `${key}.checkpoint.json`), reportPath = resolve(directory, `${key}.report.json`);
    let previous = null;
    try { previous = JSON.parse(await readFile(checkpointPath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const deadline = AbortSignal.timeout(45_000);
    const rpc = pilotRpc(env.FLURBO_ALCHEMY_TESTNET_RPC_URL || 'https://testnet-rpc.monad.xyz', (url, options) =>
      request(url, { ...options, signal: AbortSignal.any([deadline, options.signal]) }));
    let result;
    try { result = await checkSettlement({ manifest, rpc, now, previous }); }
    catch {
      const failure = { schema: 'flurbo.settlement-monitor.v1', status: 'check_failed', checkedAt: now(), pool: manifest.pool,
        lastSuccessfulCheck: previous?.checkedAt ?? null,
        alerts: [{ code: 'MONITOR_READ_FAILED', severity: 'critical', message: 'Chain state could not be verified. Prior state is not current; inspect the RPC, manifest and resolver manually.' }],
        notice: 'No transaction or email sent. The previous successful checkpoint is unchanged.' };
      await writeAtomic(reportPath, failure); output(JSON.stringify(failure, null, 2)); return 2;
    }
    // Write the visible report first. A failed check or failed report write cannot advance the checkpoint.
    await writeAtomic(reportPath, result.report);
    await writeAtomic(checkpointPath, result.checkpoint);
    output(JSON.stringify(result.report, null, 2));
    return result.report.status === 'attention_required' ? 1 : 0;
  } catch {
    output(JSON.stringify({ schema: 'flurbo.settlement-monitor.v1', status: 'check_failed', checkedAt: now(),
      alerts: [{ code: 'MONITOR_SETUP_FAILED', severity: 'critical', message: 'Check manifest configuration, checkpoint files, write permissions and whether another checker holds the lock. No successful read is certified.' }],
      notice: 'Upstream errors and endpoint credentials are withheld. No transaction or email sent.' })); return 2;
  } finally {
    if (releaseLock) try { await releaseLock(); }
    catch { output(JSON.stringify({ status: 'check_failed', message: 'Monitor lock cleanup failed. Inspect the local checkpoint directory before retrying.' })); return 2; }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runSettlementCheck();
}
