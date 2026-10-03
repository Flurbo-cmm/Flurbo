import { createPublicClient, createWalletClient, http, parseEther, formatEther, keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { monadTestnet } from 'viem/chains';

// One-time test MON, sent automatically when an approved account links its first trading wallet, so a new
// member can pay gas for the test AUSD claim and first trades without an external faucet. Once per Mera
// account and once per wallet, ever, only while the wallet is low, under a daily service cap. After that,
// members use the Monad faucet. Test funds only.
const KEY = 'flurbo:starter:v2';
export const LOW_BALANCE = parseEther('0.1');
const address = value => typeof value === 'string' && /^0x[0-9a-f]{40}$/.test(value);

export function starterConfig(env = process.env) {
  const raw = env.FLURBO_STARTER_PRIVATE_KEY?.trim();
  if (!raw) return null;
  const hex = raw.replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw Error('Invalid starter funding key');
  const amount = parseEther(env.FLURBO_STARTER_MON || '0.5'), dailyLimit = Number(env.FLURBO_STARTER_DAILY_LIMIT || 50);
  if (amount <= 0n || amount > parseEther('2') || !Number.isInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 1000) throw Error('Invalid starter funding limits');
  return { privateKey: `0x${hex}`, amount, dailyLimit };
}

export function starterFunds({ config, command, rpcUrl, now = () => Date.now(), client = null, wallet = null, sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
  if (!config || !command) return null;
  const account = privateKeyToAccount(config.privateKey);
  const transport = http(rpcUrl, { retryCount: 0, timeout: 15_000 });
  const reader = client || createPublicClient({ chain: monadTestnet, transport });
  const sender = wallet || createWalletClient({ account, chain: monadTestnet, transport });
  const low = LOW_BALANCE < config.amount ? LOW_BALANCE : config.amount;
  const accountKey = login => `${KEY}:account:${login}`, walletKey = target => `${KEY}:wallet:${target}`;
  // A signed send whose broadcast failed or timed out without showing on chain. A retry rebroadcasts these
  // exact bytes instead of signing a new transaction, so the same payment can land at most once.
  const unsentKey = target => `${KEY}:unsent:${target}`;
  const seen = hash => reader.getTransaction({ hash }).then(tx => !!tx, () => false);
  // A just-broadcast transaction can take a moment to become visible; look a few times before giving up.
  const arrived = async hash => { for (let i = 0; i < 4; i++) { if (i) await sleep(1500); if (await seen(hash)) return true; } return false; };
  const dayKey = () => `${KEY}:day:${new Date(now()).toISOString().slice(0, 10)}`;
  return {
    amountMon: formatEther(config.amount), address: account.address.toLowerCase(), amountWei: config.amount,
    // sent: this account already received it; exhausted: today's service cap is used; available otherwise.
    async status(login) {
      login = String(login).toLowerCase();
      if (!address(login)) throw Object.assign(Error('Invalid account'), { status: 400 });
      const record = await command('GET', accountKey(login));
      if (record !== null) { try { return { status: 'sent', amountMon: formatEther(config.amount), hash: JSON.parse(record).hash ?? null }; } catch { return { status: 'sent', amountMon: formatEther(config.amount), hash: null }; } }
      return { status: Number(await command('GET', dayKey()) || 0) >= config.dailyLimit ? 'exhausted' : 'available', amountMon: formatEther(config.amount) };
    },
    async send(login, target) {
      login = String(login).toLowerCase(); target = String(target).toLowerCase();
      if (!address(login) || !address(target)) throw Object.assign(Error('Invalid wallet'), { status: 400 });
      if (await reader.getChainId() !== 10143) throw Object.assign(Error('Wrong network'), { status: 503 });
      if (await reader.getBalance({ address: target }) >= low) throw Object.assign(Error('This wallet already has test MON for network fees.'), { status: 409, code: 'HAS_MON' });
      // Reserve both identities before counting against the service cap, so a repeat request is refused
      // without spending cap.
      if (await command('SET', accountKey(login), target, 'NX') !== 'OK') throw Object.assign(Error('Your free test MON was already sent. Use the Monad faucet for more.'), { status: 409, code: 'ALREADY_SENT' });
      if (await command('SET', walletKey(target), login, 'NX') !== 'OK') {
        await command('DEL', accountKey(login));
        throw Object.assign(Error('This wallet already received free test MON. Use the Monad faucet for more.'), { status: 409, code: 'ALREADY_SENT' });
      }
      const day = dayKey(), count = Number(await command('INCR', day));
      await command('EXPIRE', day, 172800);
      if (count > config.dailyLimit) {
        await command('DECR', day);
        await command('DEL', accountKey(login), walletKey(target));
        throw Object.assign(Error("Today's free test MON has run out. Use the Monad faucet, or try again tomorrow."), { status: 429, code: 'DAILY_LIMIT' });
      }
      // Sign locally first so the hash is known before broadcasting. After a failed or timed-out broadcast the
      // chain is checked for that exact transaction; if it is still not visible, the signed bytes are kept and a
      // retry rebroadcasts them. A new transaction is signed only when the kept one can no longer land (its
      // nonce was used by another send), so a retry can never pay the same person twice.
      let serializedTransaction = null, hash = null, nonce = null;
      try {
        const kept = await command('GET', unsentKey(target));
        if (kept !== null) {
          const saved = JSON.parse(kept);
          if (await seen(saved.hash)) hash = saved.hash;
          else if (await reader.getTransactionCount({ address: account.address }) > saved.nonce) await command('DEL', unsentKey(target));
          else ({ raw: serializedTransaction, hash, nonce } = saved);
        }
        if (hash === null) {
          const request = await sender.prepareTransactionRequest({ account, to: target, value: config.amount, chain: monadTestnet });
          nonce = request.nonce;
          serializedTransaction = await sender.signTransaction(request);
          hash = keccak256(serializedTransaction);
        }
        if (serializedTransaction !== null) await sender.sendRawTransaction({ serializedTransaction });
      } catch {
        if (hash === null || !await arrived(hash)) {
          if (serializedTransaction !== null) await command('SET', unsentKey(target), JSON.stringify({ raw: serializedTransaction, hash, nonce }), 'EX', 86400);
          await command('DEL', accountKey(login), walletKey(target));
          await command('DECR', day);
          throw Object.assign(Error('Free test MON could not be sent right now. Try again shortly or use the Monad faucet.'), { status: 503 });
        }
      }
      await command('DEL', unsentKey(target));
      await command('SET', accountKey(login), JSON.stringify({ wallet: target, hash, at: now() }));
      return { hash, amountMon: formatEther(config.amount) };
    },
  };
}
