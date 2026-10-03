// Pure schedule of resolver actions the worker may take without a person, derived only from
// on-chain resolver state and the committed publication. No wall clock, storage or network.
// It mirrors nextResolutionAction: an action is listed only if that planner could return it.

const time = value => {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('Invalid calendar time');
  return n;
};

export function settlementCalendar(state, { owner, owned = {}, evidence = false } = {}) {
  const p = state?.manifest?.publication, pool = state?.manifest?.pool;
  if (!p?.draft?.events || !Array.isArray(state.cases) || state.cases.length !== p.draft.events.length) throw new Error('Invalid calendar state');
  const snapshot = { blockNumber: String(state.snapshot.blockNumber), timestamp: time(state.snapshot.timestamp) };
  if (state.delivered) return { pool, snapshot, complete: true, entries: [], watch: [] };
  const entries = [], watch = [];
  // Phases a person may need to act on, whether or not the bot has anything to do. Monitoring must stay
  // fresh for all of them, especially foreign assertions that only a challenge can correct.
  state.cases.forEach((c, event) => {
    if (c.phase === 1) watch.push({ event, reason: owner && c.asserter?.toLowerCase() === owner.toLowerCase() ? 'own-assertion' : 'foreign-assertion', until: time(c.challengeUntil) });
    else if (c.phase === 2) watch.push({ event, reason: 'dispute', until: time(c.voteUntil) });
    else if (c.phase === 0 && snapshot.timestamp >= time(p.draft.events[event].observationEndsAt)) {
      const deadline = time(c.assertionDeadline);
      watch.push({ event, reason: snapshot.timestamp >= deadline ? 'assertion-timeout' : 'assertion-window', until: deadline });
    }
  });
  if (state.cases.every(c => c.phase === 3)) watch.push({ event: null, reason: 'delivery-pending', until: null });
  if (state.cases.every(c => c.phase === 3)) entries.push({ action: 'deliver', event: null, readyAt: 0, deadline: null });
  state.cases.forEach((c, event) => {
    if (c.phase === 3) return;
    if (c.phase === 0) {
      const deadline = time(c.assertionDeadline);
      // Preserve the published rehearsal B dispute and C no-assertion exercises.
      if (evidence && !(p.mode === 'rehearsal' && ![0, 3].includes(event)))
        entries.push({ action: 'evidence', event, readyAt: time(p.draft.events[event].observationEndsAt), deadline });
      entries.push({ action: 'finalize', event, readyAt: deadline, deadline: null });
    } else if (c.phase === 1) {
      // Only the worker's own, journaled assertion. Foreign assertions need supervision.
      // owned=null (the alarm, which cannot read the journal) falls back to the public asserter.
      const mine = owner && c.asserter?.toLowerCase() === owner.toLowerCase()
        && (owned === null || owned[event]?.evidenceHash === c.evidenceHash && owned[event]?.outcome === c.proposal);
      if (mine) entries.push({ action: 'finalize', event, readyAt: time(c.challengeUntil), deadline: null });
    } else if (c.phase === 2) {
      entries.push({ action: 'finalize', event, readyAt: time(c.voteUntil), deadline: null });
    }
  });
  return { pool, snapshot, complete: false, entries, watch };
}

// An evidence proposal is only useful before its assertion deadline; finishing actions never expire.
export const dueEntries = (calendar, now) =>
  calendar.entries.filter(e => e.readyAt <= now && (e.deadline === null || now < e.deadline));

export function nextWake(calendars, now) {
  const times = calendars.flatMap(c => c.entries.map(e => e.readyAt)).filter(t => t > now);
  return times.length ? Math.min(...times) : null;
}

// Earliest deadline first. Evidence has a hard deadline; finishing actions follow, oldest first.
export function priority(entry) {
  return [entry.deadline ?? Number.MAX_SAFE_INTEGER, entry.readyAt];
}
