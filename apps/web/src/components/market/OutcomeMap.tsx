import type { WhatIfCell } from '../../what-if-client';
import type { Rule } from '../../ticket-copy';

type MapLeg = { eventIndex: number; side: 'yes' | 'no' };

const pct = (tenths: number | null) => tenths === null ? 'n/a' : `${(tenths / 10).toFixed(1)}%`;
const word = (side: 'yes' | 'no') => side === 'yes' ? 'yes' : 'no';

function localCells(legs: MapLeg[], rule: Rule): WhatIfCell[] {
  const sorted = [...legs].sort((a, b) => a.eventIndex - b.eventIndex);
  return Array.from({ length: 2 ** sorted.length }, (_, state) => {
    const answers = sorted.map((leg, i) => ({ eventIndex: leg.eventIndex, side: state >> i & 1 ? 'yes' as const : 'no' as const }));
    const hits = answers.filter((answer, i) => answer.side === sorted[i].side).length;
    return { state, answers, chance: null, pays: rule === 'AND' ? hits === sorted.length : rule === 'OR' ? hits > 0 : hits === 1 };
  });
}

// The outcomes of the linked questions. Marked cells pay; each shows the pool's chance for that outcome when it is known.
export default function OutcomeMap({ legs, rule, cells }: { legs: MapLeg[]; rule: Rule; cells: WhatIfCell[] | null }) {
  const all = cells ?? localCells(legs, rule);
  const show = (cell: WhatIfCell) => cell.chance !== null ? pct(cell.chance) : cell.pays ? 'Pays' : 'No payout';
  const sorted = [...legs].sort((a, b) => a.eventIndex - b.eventIndex);
  if (legs.length === 2) {
    const [row, column] = legs;
    const find = (r: 'yes' | 'no', c: 'yes' | 'no') => all.find(cell => cell.answers.some(a => a.eventIndex === row.eventIndex && a.side === r)
      && cell.answers.some(a => a.eventIndex === column.eventIndex && a.side === c))!;
    const cell = (r: 'yes' | 'no', c: 'yes' | 'no') => {
      const found = find(r, c);
      return <td className={found.pays ? 'is-pays' : 'is-out'}>{show(found)}{found.pays && <span className="sr-only"> pays</span>}</td>;
    };
    return <table className="outcome-map">
      <caption className="sr-only">Outcome map. Marked outcomes pay.</caption>
      <thead><tr><td className="map-empty" /><th scope="col">Q{column.eventIndex + 1} {word('yes')}</th><th scope="col">Q{column.eventIndex + 1} {word('no')}</th></tr></thead>
      <tbody>
        <tr><th scope="row">Q{row.eventIndex + 1} {word('yes')}</th>{cell('yes', 'yes')}{cell('yes', 'no')}</tr>
        <tr><th scope="row">Q{row.eventIndex + 1} {word('no')}</th>{cell('no', 'yes')}{cell('no', 'no')}</tr>
      </tbody>
    </table>;
  }
  const order = sorted.map(leg => `Q${leg.eventIndex + 1}`).join(', ');
  const rows = [all.slice(0, 4), all.slice(4)];
  return <>
    <table className="outcome-map outcome-map-wide">
      <caption className="sr-only">Outcome map. Marked outcomes pay.</caption>
      <tbody>{rows.map((group, i) => <tr key={i}>{group.map(cell => <td key={cell.state} className={cell.pays ? 'is-pays' : 'is-out'}>
        <abbr className="map-key" title={cell.answers.map(a => `Q${a.eventIndex + 1} ${word(a.side)}`).join(', ')}>{cell.answers.map(a => a.side === 'yes' ? 'Y' : 'N').join(' ')}</abbr>
        <span className="sr-only">{cell.answers.map(a => `Q${a.eventIndex + 1} ${word(a.side)}`).join(', ')}: </span>
        <span className="map-val">{show(cell)}</span>{cell.pays && <span className="sr-only"> pays</span>}
      </td>)}</tr>)}</tbody>
    </table>
    <p className="slip-caption">Each cell reads the answers in the order {order}.</p>
  </>;
}
