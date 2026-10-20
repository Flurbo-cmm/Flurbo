import { decodeClaim } from '../shared/claims.mjs';

export type ComboState = { extra1: string; extra2: string; extra1Side: 'yes' | 'no'; extra2Side: 'yes' | 'no' };
export type ComboRule = 'AND' | 'OR' | 'EXACTLY_ONE';
type Other = { id: string; question: string };
type Located = { id: string; eventIndex: number };
const EMPTY: ComboState = { extra1: '', extra2: '', extra1Side: 'yes', extra2Side: 'yes' };

export const legCount = (value: ComboState) => 1 + (value.extra1 ? 1 : 0) + (value.extra2 ? 1 : 0);

export function addExtra(value: ComboState, id: string): ComboState {
  if (!value.extra1) return { ...value, extra1: id, extra1Side: 'yes' };
  if (!value.extra2) return { ...value, extra2: id, extra2Side: 'yes' };
  return value;
}

export function removeExtra(value: ComboState, slot: 1 | 2): ComboState {
  return slot === 1
    ? { ...value, extra1: value.extra2, extra1Side: value.extra2 ? value.extra2Side : 'yes', extra2: '', extra2Side: 'yes' }
    : { ...value, extra2: '', extra2Side: 'yes' };
}

// The pool's strongest links to this question, as ticket suggestions. `addable` is null until the pool has said which
// questions it can still price with the chosen ones.
export function suggestedLinks(links: { other: number; difference: number | null }[], value: ComboState, others: Located[],
  addable: number[] | null, limit = 3): { id: string; eventIndex: number; difference: number | null }[] {
  if (value.extra1 && value.extra2) return [];
  return links.flatMap(link => {
    const item = others.find(other => other.eventIndex === link.other);
    if (!item || item.id === value.extra1 || item.id === value.extra2 || addable && !addable.includes(item.eventIndex)) return [];
    return [{ id: item.id, eventIndex: item.eventIndex, difference: link.difference }];
  }).slice(0, limit);
}

// A held position fills the slip only when it includes the question on the page and has an exact named rule.
export function claimToCombo(scope: number, mask: string, events: number, anchor: number, others: Located[]):
  { side: 'yes' | 'no'; combo: ComboState; rule: ComboRule } | null {
  let named: ReturnType<typeof decodeClaim>;
  try { named = decodeClaim(scope, mask, events); } catch { return null; }
  if (!named || named.rule === 'AT_LEAST_TWO') return null;
  const own = named.legs.find(leg => leg.event === anchor);
  if (!own) return null;
  const rest = named.legs.filter(leg => leg.event !== anchor).map(leg => ({ item: others.find(other => other.eventIndex === leg.event), side: leg.yes ? 'yes' as const : 'no' as const }));
  if (rest.some(leg => !leg.item)) return null;
  const combo = { ...rest.reduce((state, leg) => addExtra(state, leg.item!.id), EMPTY) };
  if (rest[0]) combo.extra1Side = rest[0].side;
  if (rest[1]) combo.extra2Side = rest[1].side;
  return { side: own.yes ? 'yes' : 'no', combo, rule: named.rule };
}

export function readComboSearch(search: string, others: Located[]): { side: 'yes' | 'no'; combo: ComboState; rule: ComboRule } {
  const params = new URLSearchParams(search);
  const pick = (name: string) => {
    const value = params.get(name);
    return value === null ? undefined : others.find(item => item.eventIndex === Number(value));
  };
  const first = pick('other'), third = pick('third');
  const second = third && third.id !== first?.id ? third : undefined;
  const [one, two] = first ? [first, second] : [second, undefined];
  const sideOf = (name: string) => params.get(name) === 'no' ? 'no' as const : 'yes' as const;
  const rule = params.get('rule');
  return { side: sideOf('answer'),
    combo: { extra1: one?.id ?? '', extra2: two?.id ?? '',
      extra1Side: sideOf(first ? 'otherAnswer' : 'thirdAnswer'), extra2Side: two ? sideOf('thirdAnswer') : 'yes' },
    rule: rule === 'OR' || rule === 'EXACTLY_ONE' ? rule : 'AND' };
}

export function writeComboSearch(params: URLSearchParams, state: { side: 'yes' | 'no'; combo: ComboState; rule: ComboRule }, others: Located[]) {
  params.set('answer', state.side);
  const second = others.find(item => item.id === state.combo.extra1), third = others.find(item => item.id === state.combo.extra2);
  if (second) { params.set('other', String(second.eventIndex)); params.set('otherAnswer', state.combo.extra1Side); }
  else { params.delete('other'); params.delete('otherAnswer'); }
  if (third) { params.set('third', String(third.eventIndex)); params.set('thirdAnswer', state.combo.extra2Side); }
  else { params.delete('third'); params.delete('thirdAnswer'); }
  if (second) params.set('rule', state.rule); else params.delete('rule');
}

// Up to two more questions beside the one on the page, in the order they were chosen.
export function chosenChips(others: Other[], value: ComboState) {
  return ([[value.extra1, value.extra1Side, 1], [value.extra2, value.extra2Side, 2]] as const).flatMap(([id, side, slot]) => {
    const item = id ? others.find(other => other.id === id) : undefined;
    return item ? [{ id: item.id, question: item.question, side, slot }] : [];
  });
}

export function availableToAdd(others: Other[], value: ComboState, search = '') {
  if (value.extra1 && value.extra2) return [];
  const needle = search.trim().toLowerCase();
  return others.filter(item => item.id !== value.extra1 && item.id !== value.extra2 && (!needle || item.question.toLowerCase().includes(needle)));
}

// A set of answers (for example a scenario's assumptions) as the ticket's state. The page's question supplies the main
// answer, Yes when the answers do not name it; the rest become the added lines in order.
export function legsToCombo(legs: { eventIndex: number; side: 'yes' | 'no' }[], anchor: number, others: Located[]): { side: 'yes' | 'no'; combo: ComboState } {
  const own = legs.find(leg => leg.eventIndex === anchor);
  const rest = legs.filter(leg => leg.eventIndex !== anchor).flatMap(leg => {
    const item = others.find(other => other.eventIndex === leg.eventIndex);
    return item ? [{ id: item.id, side: leg.side }] : [];
  }).slice(0, 2);
  return { side: own?.side ?? 'yes', combo: { extra1: rest[0]?.id ?? '', extra1Side: rest[0]?.side ?? 'yes', extra2: rest[1]?.id ?? '', extra2Side: rest[1]?.side ?? 'yes' } };
}
