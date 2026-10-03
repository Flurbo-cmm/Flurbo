import { createHash, randomUUID } from 'node:crypto';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const email = value => typeof value === 'string' && value.length <= 254 && /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(value);

export function emailConfig(env) {
  if (!email(env.FLURBO_MONITOR_EMAIL_TO) || !email(env.FLURBO_MONITOR_EMAIL_FROM)
    || !/^re_[A-Za-z0-9_-]+$/.test(env.FLURBO_MONITOR_RESEND_KEY || '')) throw new Error('Email configuration required');
  return { from: env.FLURBO_MONITOR_EMAIL_FROM, to: [env.FLURBO_MONITOR_EMAIL_TO], key: env.FLURBO_MONITOR_RESEND_KEY };
}

export function resendDelivery(config, request = fetch) {
  return async pending => {
    try {
      const response = await request('https://api.resend.com/emails', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
        headers: { Authorization: `Bearer ${config.key}`, 'Content-Type': 'application/json', 'Idempotency-Key': pending.key },
        body: JSON.stringify(pending.body),
      });
      if (!response.ok) throw new Error();
      const result = await response.json();
      if (typeof result.id !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(result.id)) throw new Error();
      return result.id; // Provider acceptance, not confirmed inbox delivery.
    } catch { throw new Error('Email not acknowledged; pending delivery retained'); }
  };
}

// Ignore changing block numbers/countdowns and transient CASE_CHANGED notifications.
// Persistent case contents detect votes and new evidence without sending on every poll.
export function reportSignature(report) {
  return digest({ status: report.status, lifecycle: report.lifecycle,
    alerts: report.alerts.filter(a => !['CASE_CHANGED', 'SETTLEMENT_DELIVERED'].includes(a.code))
      .map(a => [a.code, a.event ?? null, a.deadline ?? null]),
    events: report.events?.map(e => [e.event, e.phase, e.proposal, e.counter, e.result, e.votes,
      e.deadline, e.evidenceHash, e.counterEvidenceHash]),
  });
}

export function validateEmailState(state, identity) {
  if (state?.schema !== 'flurbo.settlement-mail.v1' || state.identity !== identity
    || !Array.isArray(state.queue) || state.queue.length > 20
    || !Number.isSafeInteger(state.lastQueuedAt) || state.lastQueuedAt < 0
    || !(state.signature === null || /^[a-f0-9]{64}$/.test(state.signature))) throw new Error('Invalid notification state');
  for (const item of state.queue) {
    if (!/^flurbo-[a-f0-9-]{36}$/.test(item.key) || !Number.isSafeInteger(item.createdAt)
      || !email(item.body?.from) || item.body?.to?.length !== 1 || !email(item.body.to[0])
      || typeof item.body.subject !== 'string' || item.body.subject.length > 150 || /[\r\n]/.test(item.body.subject)
      || typeof item.body.text !== 'string' || item.body.text.length > 50_000) throw new Error('Invalid pending email');
  }
}

export function queueReport(state, report, config, now, { test = false } = {}) {
  const next = structuredClone(state), signature = reportSignature(report);
  const active = report.alerts.some(a => a.severity !== 'info');
  const changed = state.signature !== null && signature !== state.signature;
  const notify = test || changed || (state.signature === null && report.alerts.length > 0)
    || (active && now - state.lastQueuedAt >= 3600);
  if (notify) {
    if (next.queue.length >= 20) throw new Error('Email queue full; inspect monitor');
    const body = { from: config.from, to: config.to,
      subject: test ? 'Flurbo settlement monitor: delivery test' : `Flurbo settlement: ${report.status}`,
      text: [
        test ? 'DELIVERY TEST. This email does not establish continuous coverage.' : 'Settlement observation. Review manually; no transaction was submitted.',
        `Observed at ${new Date(report.checkedAt * 1000).toISOString()}. This queued observation may be older than the current chain state.`,
        `Monad testnet pool: ${report.pool}`, `Resolver: ${report.resolver}`,
        `Block: ${report.snapshot?.blockNumber ?? 'unverified'}. Status: ${report.status}.`,
        ...report.alerts.map(a => `${a.severity.toUpperCase()} ${a.code}: ${a.message}`),
        ...(report.events?.map(e => `${e.question}: ${e.phase}; proposal ${e.proposal}; result ${e.result}. ${e.action} Deadline: ${e.deadline === null ? 'none' : new Date(e.deadline * 1000).toISOString()}.`) ?? []),
        'A wrong uncontested assertion can finalize. Monitoring does not verify truth or reverse settlement.',
        'If this is a recovery notice, verify the latest resolver state. Provider acceptance is not proof that earlier messages reached your inbox.',
      ].join('\n\n') };
    next.queue.push({ key: `flurbo-${randomUUID()}`, createdAt: now, body });
    next.lastQueuedAt = now;
  }
  next.signature = signature;
  return next;
}

// One outbox for chain read failures across every monitored pool. A public RPC hiccup fails every pool at once,
// so a single email names them all, repeats hourly while it lasts, and a single email reports recovery.
export const READ_FAILURE_IDENTITY = 'flurbo:monitor:read-failures:v1';
const bothZones = seconds => {
  const at = new Date(seconds * 1000);
  return `${at.toISOString().slice(0, 16).replace('T', ' ')} UTC (${new Date(at.getTime() + 19_800_000).toISOString().slice(11, 16)} IST)`;
};
export function queueReadFailures(state, failing, config, now) {
  const next = structuredClone(state);
  const signature = failing.length ? digest(failing.map(f => f.pool).sort()) : null;
  const recovered = !failing.length && state.signature !== null;
  const notify = recovered || (failing.length && (signature !== state.signature || now - state.lastQueuedAt >= 3600));
  if (notify) {
    if (next.queue.length >= 20) throw new Error('Email queue full; inspect monitor');
    const text = recovered ? [
      `Chain reads recovered at ${bothZones(now)}. Every monitored pool was read and verified again.`,
      'No transaction was submitted by the monitor. Settlement continued on its own schedule.',
    ] : [
      `The settlement monitor could not read Monad testnet for ${failing.length} pool${failing.length === 1 ? '' : 's'} on at least two checks in a row, retrying each read three times, as of ${bothZones(now)}.`,
      ...failing.map(f => `Pool ${f.pool}: ${f.readFailures} failed checks in a row.`),
      'Settlement retries on its own; nothing is lost while reads fail. The last verified observation stays valid. If this lasts more than 15 minutes, a check gap alert follows for each pool, and this email repeats every hour until reads recover.',
      'Check the RPC provider status. No transaction was submitted by the monitor.',
    ];
    next.queue.push({ key: `flurbo-${randomUUID()}`, createdAt: now, body: { from: config.from, to: config.to,
      subject: recovered ? 'Flurbo settlement monitor: chain reads recovered' : 'Flurbo settlement monitor: chain reads failing', text: text.join('\n\n') } });
    next.lastQueuedAt = now;
  }
  next.signature = signature;
  return next;
}

export async function drainEmails(state, { save, renew, send, now }) {
  // At most three attempts per invocation; the next scheduled run resumes the outbox.
  let accepted = 0;
  while (state.queue.length && accepted < 3) {
    await renew();
    const item = state.queue[0], age = now() - item.createdAt;
    // Resend remembers keys for 24 hours. Never blindly retry an older uncertain send.
    if (age < 0 || age >= 23 * 3600) throw new Error('Pending email needs manual reconciliation');
    const providerId = await send(item);
    const next = structuredClone(state);
    next.queue.shift(); next.lastAccepted = { key: item.key, providerId, at: now() };
    await save(next); // If acknowledgement storage fails, retry the SAME key and payload.
    state = next; accepted++;
  }
  return { state, accepted };
}
