import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEther } from 'viem';
import { fundingAlerts } from '../server/funding-alerts.mjs';

const DISPENSER = '0x' + '5b'.repeat(20), STARTER = '0x' + '8c'.repeat(20);
const email = { FLURBO_MONITOR_EMAIL_TO: 'to@example.com', FLURBO_MONITOR_EMAIL_FROM: 'from@example.com', FLURBO_MONITOR_RESEND_KEY: 're_test' };

function harness({ ausd = 3_750_000_000n, mon = parseEther('50'), env = email as Record<string, string>, fail = false } = {}) {
  const kv = new Map<string, string>(), sent: any[] = [], clock = { now: 1_800_000_000_000 }, balances = { ausd, mon };
  const command = async (op: string, key: string, value?: string, ...rest: any[]) => {
    if (op === 'SET') { if (rest.includes('NX') && kv.has(key)) return null; kv.set(key, String(value)); return 'OK'; }
    if (op === 'DEL') return kv.delete(key) ? 1 : 0;
    throw Error('unexpected ' + op);
  };
  const client: any = { readContract: async () => balances.ausd, getBalance: async () => balances.mon };
  const alerts = fundingAlerts({ env, rpcUrl: 'https://testnet-rpc.monad.xyz', command, dispenser: DISPENSER, starter: { address: STARTER, amount: parseEther('0.3') },
    client, now: () => clock.now, deliver: async (item: any) => { if (fail) throw Error('resend down'); sent.push(item); return 'id'; } })!;
  return { alerts, sent, clock, balances, kv };
}

test('healthy balances report how many members they cover and send nothing', async () => {
  const h = harness();
  assert.equal(await h.alerts.tick(), 'ok');
  const s = h.alerts.latest()!;
  assert.deepEqual([s.dispenser.left, s.dispenser.low, s.starter.left, s.starter.low], [75, false, 166, false]);
  assert.equal(h.sent.length, 0);
});

test('a low wallet emails once, repeats only after 12 hours, and balances are read at most every 30 minutes', async () => {
  const h = harness({ ausd: 400_000_000n });
  assert.equal(await h.alerts.tick(), 'low_emailed');
  assert.match(h.sent[0].body.subject, /Test AUSD dispenser/);
  assert.match(h.sent[0].body.text, /400 test AUSD left, enough for about 8 claims/);
  assert.equal(await h.alerts.tick(), 'low', 'cached within 30 minutes');
  h.clock.now += 31 * 60_000;
  assert.equal(await h.alerts.tick(), 'low', 'already emailed in the last 12 hours');
  h.clock.now += 12 * 3_600_000; h.kv.clear(); // the 12-hour reminder key has expired
  assert.equal(await h.alerts.tick(), 'low_emailed');
  assert.equal(h.sent.length, 2);
});

test('both wallets low produce one combined email; a failed send is retried next check', async () => {
  const h = harness({ ausd: 0n, mon: parseEther('1'), fail: true });
  await assert.rejects(h.alerts.tick());
  assert.equal(h.kv.size, 0, 'the reminder is released so the next check retries');
  const ok = harness({ ausd: 0n, mon: parseEther('1') });
  assert.equal(await ok.alerts.tick(), 'low_emailed');
  assert.match(ok.sent[0].body.subject, /dispenser, Starter MON wallet/);
  assert.equal(harness({ ausd: 0n, env: {} }).alerts.tick instanceof Function, true);
  assert.equal(await harness({ ausd: 0n, env: {} }).alerts.tick(), 'low_no_email');
  assert.equal(fundingAlerts({ command: null as any, rpcUrl: '', dispenser: DISPENSER }), null);
});
