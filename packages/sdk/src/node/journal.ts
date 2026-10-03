import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync, existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { FlurboError } from '../errors.ts';
import type { JournalStatus, PolicyEntry } from '../policy.ts';
import { UNFINISHED } from '../policy.ts';

// The runtime's durable record of every transaction intent (protocol/specs/transactions.md). One journal
// per agent wallet, in the operator's state directory. Every change happens under an exclusive lock file
// shared by all processes using the directory, and is written atomically (temporary file, flush, rename),
// so a crash leaves either the old or the new journal, never a partial one.
export type JournalAction = 'approve' | 'buy' | 'sell' | 'redeem';
export type JournalEntry = {
  id: string; action: JournalAction; namespace: string; pool: string; claim: { scope: number; mask: string } | null;
  quantityAtoms: string; limitAtoms: string; deadline: number | null; status: JournalStatus; plannedAt: number; decisionId: string | null;
  to: string; data: string; gas: string | null; maxFeePerGas: string | null; maxPriorityFeePerGas: string | null;
  nonce: number | null; rawTransaction: string | null; hash: string | null; signedAt: number | null; broadcastAt: number | null; finalAt: number | null;
  costAtoms: string | null; receipt: { blockNumber: string; gasUsed: string; effectiveGasPrice: string | null } | null; note: string | null;
  owner: { pid: number; host: string };
  report: { status: 'none' | 'pending' | 'accepted' | 'rejected'; attempts: number; flurboStatus: string | null };
};
export type JournalFile = { schema: 'flurbo.agent-journal.v1'; wallet: string; chainId: 10143; entries: JournalEntry[] };
export const isFinal = (e: { status: JournalStatus }) => !UNFINISHED.includes(e.status);
export const policyEntries = (j: JournalFile): PolicyEntry[] => j.entries.map(e => ({ id: e.id, action: e.action, namespace: e.namespace, claim: e.claim,
  quantityAtoms: e.quantityAtoms, limitAtoms: e.limitAtoms, costAtoms: e.costAtoms, status: e.status, plannedAt: e.plannedAt }));

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
// On Windows a file being deleted or read by another process briefly refuses opens and renames (EPERM,
// EACCES, EBUSY). These mean "someone else is using it", never "you may not".
const transient = (e: unknown) => ['EPERM', 'EACCES', 'EBUSY'].includes((e as NodeJS.ErrnoException).code ?? '');
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };

export class FileJournal {
  readonly file: string; readonly lockFile: string; readonly dir: string; readonly wallet: string; readonly options: { lockTimeoutMs?: number; staleMs?: number };
  constructor(dir: string, wallet: string, options: { lockTimeoutMs?: number; staleMs?: number } = {}) {
    this.dir = dir; this.wallet = wallet; this.options = options;
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, 'journal.json'); this.lockFile = join(dir, 'journal.lock');
  }
  read(): JournalFile {
    if (!existsSync(this.file)) return { schema: 'flurbo.agent-journal.v1', wallet: this.wallet, chainId: 10143, entries: [] };
    const j = JSON.parse(readFileSync(this.file, 'utf8')) as JournalFile;
    if (j.schema !== 'flurbo.agent-journal.v1' || j.chainId !== 10143) throw new FlurboError('invalid_input', 'The journal file is not a Flurbo agent journal.');
    if (j.wallet !== this.wallet) throw new FlurboError('invalid_input', `This state directory belongs to wallet ${j.wallet}. Use one state directory per agent wallet.`);
    return j;
  }
  private write(j: JournalFile) {
    const tmp = this.file + '.tmp', fd = openSync(tmp, 'w');
    try { writeSync(fd, JSON.stringify(j, null, 1)); fsyncSync(fd); } finally { closeSync(fd); }
    for (let attempt = 0; ; attempt++) {
      try { renameSync(tmp, this.file); return; }
      catch (e) { if (!transient(e) || attempt >= 50) throw e; const until = Date.now() + 10; while (Date.now() < until) { /* brief wait for a concurrent reader */ } }
    }
  }
  // A lock older than `staleMs` whose owner process is gone (same host) is taken over.
  private async acquire(): Promise<void> {
    const deadline = Date.now() + (this.options.lockTimeoutMs ?? 20_000), staleMs = this.options.staleMs ?? 30_000;
    for (;;) {
      try {
        const fd = openSync(this.lockFile, 'wx');
        try { writeSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), at: Date.now() })); } finally { closeSync(fd); }
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST' && !transient(e)) throw e;
      }
      try {
        const held = JSON.parse(readFileSync(this.lockFile, 'utf8'));
        const orphaned = held.host === hostname() ? !alive(held.pid) : false;
        if (Date.now() - held.at > staleMs && (orphaned || Date.now() - held.at > staleMs * 4)) { unlinkSync(this.lockFile); continue; }
      } catch { /* The holder is mid-write or just released; retry. */ }
      if (Date.now() > deadline) throw new FlurboError('conflict', 'The agent journal is locked by another process. Retry shortly.');
      await sleep(20 + Math.floor(Math.random() * 30));
    }
  }
  private release() { try { unlinkSync(this.lockFile); } catch { /* already gone */ } }
  // Runs `fn` on the current journal under the lock. If it returns normally the journal is written.
  async locked<T>(fn: (j: JournalFile) => Promise<T> | T): Promise<T> {
    await this.acquire();
    try {
      const j = this.read(), result = await fn(j);
      this.write(j);
      return result;
    } finally { this.release(); }
  }
  // The same lock for other state files in the directory (the paper book).
  async withLock<T>(fn: () => Promise<T> | T): Promise<T> { await this.acquire(); try { return await fn(); } finally { this.release(); } }
  static owner() { return { pid: process.pid, host: hostname() }; }
}
