import { signedPoints } from './web-layout.ts';
import type { WhatIf, WhatIfLeg } from './what-if-client.ts';

export type Shift = { eventIndex: number; yes: number; givenYes: number; shift: number };

export const shiftText = (tenths: number) => signedPoints(tenths);

// Every question the assumptions do not name, ordered by how far its chance moves. Questions whose conditional chance is
// withheld are left out; when every one is withheld the assumptions are too unlikely to condition on.
export function rankShifts(result: WhatIf, limit = 5): { shown: Shift[]; more: Shift[]; rare: boolean } {
  const open = result.questions.filter(question => !question.assumed);
  const rows = open.flatMap(question => question.yes === null || question.givenYes === null ? []
    : [{ eventIndex: question.eventIndex, yes: question.yes, givenYes: question.givenYes, shift: question.givenYes - question.yes }])
    .sort((a, b) => Math.abs(b.shift) - Math.abs(a.shift) || a.eventIndex - b.eventIndex);
  const rare = result.reasons.givenYes === 'rare_condition' || (result.given.length > 0 && open.length > 0 && open.every(question => question.givenYes === null));
  return { shown: rows.slice(0, limit), more: rows.slice(limit), rare };
}

// The assumptions plus the chosen question become the ticket's answers, three at most. The page's question stays first
// and the chosen one is always kept; the oldest other assumptions make room.
export function combineLegs(given: WhatIfLeg[], row: number, side: 'yes' | 'no', anchor?: number): WhatIfLeg[] {
  const seen = new Set<number>();
  const ordered = [...given.filter(leg => leg.eventIndex === anchor), ...given.filter(leg => leg.eventIndex !== anchor)]
    .filter(leg => !seen.has(leg.eventIndex) && !!seen.add(leg.eventIndex));
  if (seen.has(row)) return ordered.slice(0, 3);
  const kept = [...ordered];
  while (kept.length > 2) {
    const drop = kept.findIndex(leg => leg.eventIndex !== anchor);
    kept.splice(drop < 0 ? 0 : drop, 1);
  }
  return [...kept, { eventIndex: row, side }];
}

export function scenarioHeading(given: WhatIfLeg[]) {
  const parts = [...given].sort((a, b) => a.eventIndex - b.eventIndex).map(leg => `Q${leg.eventIndex + 1} is ${leg.side === 'yes' ? 'Yes' : 'No'}`);
  return `If ${parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`}`;
}
