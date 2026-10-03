import { createPublicClient, http, erc20Abi, formatEther, formatUnits, parseEther, parseUnits } from 'viem';
import { monadTestnet } from 'viem/chains';
import { TESTNET } from './network.mjs';
import { emailConfig, resendDelivery } from './settlement-email.mjs';

// Watches the two wallets new members depend on: the test AUSD dispenser (50 AUSD per claim) and the
// starter MON wallet. When either drops below its threshold, the operator gets one email per wallet at
// most every 12 hours, and the balances show on the operator metrics page. Read-only; never sends funds.
export const DISPENSER_CLAIM_ATOMS = 50_000_000n;
const REPEAT_SECONDS = 43_200;

export function fundingAlerts({ env = process.env, rpcUrl, command, dispenser = null, starter = null, client = null, deliver = null,
  now = Date.now, checkEveryMs = 30 * 60_000 }) {
  if (!command || (!dispenser && !starter)) return null;
  const minAusd = parseUnits(env.FLURBO_ALERT_DISPENSER_AUSD || '500', 6), minMon = parseEther(env.FLURBO_ALERT_STARTER_MON || '5');
  let reader = client, latest = null, lastAt = -Infinity;

  async function check() {
    reader ||= createPublicClient({ chain: monadTestnet, transport: http(rpcUrl, { retryCount: 0, timeout: 15_000 }) });
    const result = { checkedAt: now(), dispenser: null, starter: null };
    if (dispenser) {
      const balance = await reader.readContract({ address: TESTNET.cash, abi: erc20Abi, functionName: 'balanceOf', args: [dispenser] });
      result.dispenser = { address: dispenser, balance: formatUnits(balance, 6), unit: 'test AUSD', left: Number(balance / DISPENSER_CLAIM_ATOMS),
        leftLabel: 'claims', threshold: formatUnits(minAusd, 6), low: balance < minAusd };
    }
    if (starter) {
      const balance = await reader.getBalance({ address: starter.address });
      result.starter = { address: starter.address.toLowerCase(), balance: formatEther(balance), unit: 'test MON', left: Number(balance / starter.amount),
        leftLabel: 'new members', threshold: formatEther(minMon), low: balance < minMon };
    }
    latest = result; lastAt = now();
    return result;
  }

  const describe = (name, w) => `${name} ${w.address}: ${w.balance} ${w.unit} left, enough for about ${w.left} ${w.leftLabel}. Alert threshold: ${w.threshold} ${w.unit}.`;

  // Called every settlement-bot cycle; reads balances at most every 30 minutes.
  async function tick() {
    if (now() - lastAt < checkEveryMs) return latest ? (['dispenser', 'starter'].some(k => latest[k]?.low) ? 'low' : 'ok') : 'not_checked';
    const result = await check();
    const low = [['dispenser', 'Test AUSD dispenser'], ['starter', 'Starter MON wallet']].filter(([key]) => result[key]?.low);
    if (!low.length) return 'ok';
    if (env.FLURBO_ALERT_EMAIL === 'false') return 'low';
    let config;
    try { config = emailConfig(env); } catch { return 'low_no_email'; }
    const fresh = [];
    for (const [key, name] of low) if (await command('SET', `flurbo:alerts:v1:low:${key}`, String(now()), 'NX', 'EX', REPEAT_SECONDS) === 'OK') fresh.push([key, name]);
    if (!fresh.length) return 'low';
    const send = deliver || resendDelivery(config);
    try {
      await send({ key: `flurbo-low-funds-${fresh.map(([k]) => k).join('-')}-${Math.floor(now() / 1000 / REPEAT_SECONDS)}`,
        body: { from: config.from, to: config.to, subject: `Flurbo test funds running low: ${fresh.map(([, n]) => n).join(', ')}`,
          text: [...fresh.map(([key, name]) => describe(name, result[key])),
            'Top up by sending test funds to the address above from the deployer. New members cannot get started once these run out.',
            'You will get this reminder again in 12 hours while the balance stays low.'].join('\n\n') } });
      return 'low_emailed';
    } catch (error) {
      for (const [key] of fresh) await command('DEL', `flurbo:alerts:v1:low:${key}`);
      throw error;
    }
  }

  return { check, tick, latest: () => latest };
}
