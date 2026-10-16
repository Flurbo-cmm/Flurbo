export type ComboState = { extra1: string; extra2: string; extra1Side: 'yes' | 'no'; extra2Side: 'yes' | 'no' };
type Other = { id: string; question: string };

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
