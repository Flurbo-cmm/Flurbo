import {createHmac, randomInt, randomUUID} from 'node:crypto';

export class ApplicationError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const accountPattern = /^0x[0-9a-f]{40}$/;
const emailPattern = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const unavailable = () => new ApplicationError(503, 'Applications are temporarily unavailable. Please try again later.');

// Separate database and email credentials. No browser receives these values.
export function configureApplications(env = process.env, request = fetch) {
  if (env.FLURBO_APPLICATIONS_ENABLED !== 'true') return null;
  const url = new URL(env.FLURBO_APPLICATIONS_SUPABASE_URL || '');
  if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.supabase\.co$/.test(url.hostname) || url.username || url.password || url.port || url.search || url.hash || url.pathname !== '/') throw Error('Invalid applications database URL');
  const key = env.FLURBO_APPLICATIONS_SUPABASE_SECRET;
  const emailKey = env.FLURBO_APPLICATIONS_RESEND_KEY;
  const from = env.FLURBO_APPLICATIONS_EMAIL_FROM;
  const secret = env.FLURBO_APPLICATIONS_CODE_SECRET;
  const dailyLimit = Number(env.FLURBO_APPLICATIONS_EMAIL_DAILY_LIMIT || 50);
  if (!Number.isInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 5000) throw Error('Invalid application email daily limit');
  if (!key || !emailKey || !emailPattern.test(from || '') || !secret || secret.length < 32) throw Error('Applications require database, email and code-secret configuration');
  const db = async (action, account, data = {}) => {
    try {
      const response = await request(new URL('/rest/v1/rpc/flurbo_application', url), {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
        headers: {'Content-Type': 'application/json', apikey: key, ...(key.startsWith('sb_secret_') ? {} : {Authorization: `Bearer ${key}`})},
        body: JSON.stringify({p_action: action, p_account: account, p_data: data}),
      });
      if (!response.ok) throw unavailable();
      const result = await response.json();
      if (!result || typeof result !== 'object') throw unavailable();
      if (result.error) throw new ApplicationError(result.status || 400, result.error);
      return result;
    } catch (e) { if (e instanceof ApplicationError) throw e; throw unavailable(); }
  };
  const send = async ({to, subject, text, id, account}) => {
    await db('email_budget', account, {limit: dailyLimit});
    const response = await request('https://api.resend.com/emails', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: {'Content-Type': 'application/json', Authorization: `Bearer ${emailKey}`, 'Idempotency-Key': id},
      body: JSON.stringify({from, to: [to], subject, text}),
    });
    if (!response.ok) throw unavailable();
  };
  // Operator metrics only (migration 002). Account, state and dates; never email addresses.
  const stats = async () => {
    try {
      const response = await request(new URL('/rest/v1/rpc/flurbo_application_stats', url), {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
        headers: {'Content-Type': 'application/json', apikey: key, ...(key.startsWith('sb_secret_') ? {} : {Authorization: `Bearer ${key}`})},
        body: '{}',
      });
      if (!response.ok) throw unavailable();
      const result = await response.json();
      if (!result || !Array.isArray(result.rows)) throw unavailable();
      return result;
    } catch { throw unavailable(); }
  };
  // Position notices only (migration 003): verified emails of approved accounts among those asked about.
  const contacts = async accounts => {
    const list = [...new Set(accounts.map(a => String(a).toLowerCase()).filter(a => accountPattern.test(a)))].slice(0, 500);
    if (!list.length) return {};
    try {
      const response = await request(new URL('/rest/v1/rpc/flurbo_member_contacts', url), {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
        headers: {'Content-Type': 'application/json', apikey: key, ...(key.startsWith('sb_secret_') ? {} : {Authorization: `Bearer ${key}`})},
        body: JSON.stringify({p_accounts: list}),
      });
      if (!response.ok) throw unavailable();
      const rows = await response.json();
      if (!Array.isArray(rows)) throw unavailable();
      return Object.fromEntries(rows.filter(r => accountPattern.test(r?.account || '') && emailPattern.test(r?.email || '')).map(r => [r.account, r.email]));
    } catch { throw unavailable(); }
  };
  return {...applicationService({db, send, secret}), stats, contacts, noticeSecret: secret, noticeEmail: {key: emailKey, from}};
}

export function applicationService({db, send, secret}) {
  const identity = value => {
    const account = value?.toLowerCase();
    if (!accountPattern.test(account || '')) throw new ApplicationError(400, 'Invalid account.');
    return account;
  };
  const codeDigest = (account, code) => createHmac('sha256', secret).update(`${account}:${code}`).digest('hex');
  async function notify(account) {
    const notification = await db('notification', account);
    if (!notification.id) return {notification: 'none'};
    if (notification.expired) return {notification: 'needs_review'};
    try {
      await send({account,to: notification.email, id: notification.id, subject: 'Your Flurbo invitation is ready',
        text: 'Your Flurbo account has been approved for the Monad testnet preview. Test assets only.\n\nSign in with your existing Flurbo passkey at https://flurbo.singu.online/access\n\nThis email does not sign you in or authorize a transaction.'});
      await db('notified', account, {id: notification.id});
      return {notification: 'sent'};
    } catch { return {notification: 'pending'}; }
  }
  return {
    async allows(account, legacy = false) {
      const result = await db('decision', identity(account));
      return result.decision === null ? legacy : result.decision === 'approved';
    },
    async handle({action, account, input = {}, operator = false, budget = async () => {}}) {
      account = identity(account);
      if (action.startsWith('admin/')) {
        if (!operator) throw new ApplicationError(403, 'Operator access only.');
        if (action === 'admin/list') {
          const offset = input.offset ?? 0;
          if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000) throw new ApplicationError(400, 'Invalid page.');
          return db('list', account, {offset});
        }
        const target = identity(input.account);
        if (action === 'admin/notify') { await budget('email'); return notify(target); }
        if (action !== 'admin/decide' || !['approved', 'declined', 'revoked'].includes(input.decision) || !Number.isSafeInteger(input.revision) || input.revision < 0) throw new ApplicationError(400, 'Invalid decision.');
        const result = await db('decide', target, {decision: input.decision, revision: input.revision, operator: account});
        // Approval is durable even if notification delivery is rate-limited or unavailable.
        if (input.decision === 'approved') {
          try { await budget('email'); return {...result, ...await notify(target)}; }
          catch { return {...result, notification: 'pending'}; }
        }
        return result;
      }
      if (action === 'status') return db('status', account);
      if (action === 'withdraw') return db('withdraw', account);
      if (action === 'submit') {
        if (input.noticeAccepted !== true) throw new ApplicationError(400, 'Please acknowledge how we use your email.');
        const email = typeof input.email === 'string' ? input.email.trim() : '';
        if (email.length > 254 || !emailPattern.test(email) || email.includes('..')) throw new ApplicationError(400, 'Enter a valid email address.');
        await budget('email');
        const code = String(randomInt(0, 1000000)).padStart(6, '0');
        const id = randomUUID();
        const result = await db('submit', account, {email, codeHash: codeDigest(account, code), noticeVersion: '2026-09-30', id});
        if (!result.send) return result;
        try {
          await send({account,to: email, id, subject: 'Verify your Flurbo application email',
            text: `Your Flurbo verification code is ${code}. It expires in 10 minutes.\n\nEnter it in the account page where you requested access. This verifies your contact email only. It does not sign you in or approve access.\n\nIf you did not request this email, you can ignore it.`});
          return {application: result.application, delivery: 'sent'};
        } catch (e) { return {application: result.application, delivery: 'pending', message: e instanceof ApplicationError && e.status===429 ? e.message : 'Your request is saved, but email delivery could not be confirmed. Check your inbox or request a new code after one minute.'}; }
      }
      if (action === 'verify') {
        if (typeof input.code !== 'string' || !/^\d{6}$/.test(input.code)) throw new ApplicationError(400, 'Enter the six-digit code from your email.');
        return db('verify', account, {codeHash: codeDigest(account, input.code)});
      }
      throw new ApplicationError(404, 'Unknown application action.');
    },
  };
}
