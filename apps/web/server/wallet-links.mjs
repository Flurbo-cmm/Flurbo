import { randomBytes } from 'node:crypto';
import { verifyMessage } from 'viem';
import { digest } from './session.mjs';

const address = value => typeof value === 'string' && /^0x[0-9a-f]{40}$/i.test(value);
const MAX_WALLETS = 20;
// The key that records which Flurbo account linked a wallet for manual trading, on one origin.
export const linkOwnerKey = (origin, wallet) => `flurbo:wallet-links:v1:owner:${digest(origin + ':' + wallet.toLowerCase())}`;
// Agent wallets can never also be linked for manual trading. `isReserved(wallet)` is checked when a link is
// requested and again when it is verified; with Redis, `reservedKey(wallet)` names the agent wallet key, and
// the link is written only if that key does not exist, in the same atomic step.
export function walletLinks({ command, now = Date.now, isReserved = async () => false, reservedKey = null } = {}) {
  const challenges = new Map(), accounts = new Map(), owners = new Map(), budgets = new Map();
  const key = (kind, value) => `flurbo:wallet-links:v1:${kind}:${digest(value)}`;
  async function list(login, origin) {
    const id = origin + ':' + login;
    const wallets = command ? await command('SMEMBERS', key('account', id)) : [...(accounts.get(id) || [])];
    return { account: login, wallets: wallets.sort() };
  }
  async function challenge(login, wallet, origin, session) {
    if (!address(wallet) || wallet.toLowerCase() === login) throw Error('Choose a MetaMask trading address, not your Mera account address.');
    if (await isReserved(wallet.toLowerCase())) throw Error('This MetaMask wallet is an agent wallet. Use a separate wallet for manual trading.');
    wallet = wallet.toLowerCase();
    const rate = key('rate', session + ':' + Math.floor(now()/60000));
    const count = command ? await command('EVAL', "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],120) end; return n", 1, rate) : (budgets.get(rate) || 0) + 1;
    if (!command) { if (budgets.size > 1000) budgets.clear(); budgets.set(rate, count); }
    if (count > 10) throw Error('Too many linking attempts. Try again in a minute.');
    const id = randomBytes(32).toString('base64url'), expires = now() + 300000;
    const message = `Link MetaMask to Flurbo\nOrigin: ${origin}\nMera account: ${login}\nTrading wallet: ${wallet}\nChain: Monad testnet (10143)\nNonce: ${id}\nExpires: ${new Date(expires).toISOString()}\nThis links this wallet's public holdings and activity to your Flurbo account across devices. It does not move funds or authorize transactions.`;
    const value = { login, wallet, origin, session: digest(session), expires, message };
    if (command) await command('SET', key('challenge', id), JSON.stringify(value), 'EX', 300);
    else { for (const [k,v] of challenges) if(v.expires <= now()) challenges.delete(k); if(challenges.size>=1000) throw Error('Linking is busy. Retry shortly.'); challenges.set(id, value); }
    return { id, message };
  }
  async function verify(login, id, signature, origin, session) {
    const raw = command ? await command('GETDEL', key('challenge', id)) : challenges.get(id);
    if (!command) challenges.delete(id);
    const proof = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!proof || proof.login !== login || proof.origin !== origin || proof.session !== digest(session) || proof.expires <= now() || !/^0x[0-9a-f]{130}$/i.test(signature || '') ||
      !await verifyMessage({ address: proof.wallet, message: proof.message, signature })) throw Error('Wallet proof rejected. Reconnect and try again.');
    const accountId = origin + ':' + login, walletId = origin + ':' + proof.wallet;
    const agentWallet = 'This MetaMask wallet is an agent wallet. Use a separate wallet for manual trading.';
    if (await isReserved(proof.wallet)) throw Error(agentWallet);
    if (command) {
      const reserved = reservedKey ? reservedKey(proof.wallet) : null;
      const result = await command('EVAL', `${reserved ? "if redis.call('EXISTS',KEYS[3])==1 then return -3 end; " : ''}local owner=redis.call('GET',KEYS[2]); if owner and owner~=ARGV[1] then return -1 end; if redis.call('SISMEMBER',KEYS[1],ARGV[2])==0 and redis.call('SCARD',KEYS[1])>=${MAX_WALLETS} then return -2 end; redis.call('SET',KEYS[2],ARGV[1]); redis.call('SADD',KEYS[1],ARGV[2]); return 1`, reserved ? 3 : 2, key('account', accountId), key('owner', walletId), ...(reserved ? [reserved] : []), login, proof.wallet);
      if (result === -3) throw Error(agentWallet);
      if (result === -1) throw Error('This MetaMask wallet is linked to another Flurbo account. Sign in to that account.');
      if (result !== 1) throw Error('This account has reached its 20-wallet limit.');
    } else {
      if (owners.has(walletId) && owners.get(walletId) !== login) throw Error('This MetaMask wallet is linked to another Flurbo account. Sign in to that account.');
      const set = accounts.get(accountId) || new Set();
      if (!set.has(proof.wallet) && set.size >= MAX_WALLETS) throw Error('This account has reached its 20-wallet limit.');
      set.add(proof.wallet); accounts.set(accountId, set); owners.set(walletId, login);
    }
    return list(login, origin);
  }
  // Which Flurbo account linked this wallet for manual trading, if any.
  async function ownerOf(wallet, origin) {
    const walletId = origin + ':' + wallet.toLowerCase();
    return command ? await command('GET', key('owner', walletId)) : owners.get(walletId) ?? null;
  }
  // With Redis, the key an agent wallet claim must find absent (see linkOwnerKey); null without Redis.
  const ownerKey = (wallet, origin) => (command ? linkOwnerKey(origin, wallet) : null);
  return { list, challenge, verify, ownerOf, ownerKey };
}
