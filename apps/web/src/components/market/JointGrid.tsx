import { forwardRef } from 'react';

export type JointKey = 'yy' | 'yn' | 'ny' | 'nn';
export type JointMark = 'focus' | 'in' | 'out';
export const JOINT_KEYS: JointKey[] = ['yy', 'yn', 'ny', 'nn'];

// The outcome space of two yes-or-no questions: rows are A, columns are B. Each cell shows a price or a word and is
// marked as the part being counted (focus), the rest of the space in play (in), or set aside (out).
const JointGrid = forwardRef<HTMLTableElement, {
  caption: string; cells: Record<JointKey, string>; marks: Record<JointKey, JointMark>; a?: string; b?: string; className?: string;
}>(function JointGrid({ caption, cells, marks, a = 'A', b = 'B', className = '' }, ref) {
  const cell = (key: JointKey) => <td data-cell={key} className={`joint-cell joint-${marks[key]}`}>{cells[key]}</td>;
  return (
    <table ref={ref} className={`joint-grid ${className}`.trim()}>
      <caption className="sr-only">{caption}</caption>
      <thead><tr><td /><th scope="col">{b} yes</th><th scope="col">{b} no</th></tr></thead>
      <tbody>
        <tr><th scope="row">{a} yes</th>{cell('yy')}{cell('yn')}</tr>
        <tr><th scope="row">{a} no</th>{cell('ny')}{cell('nn')}</tr>
      </tbody>
    </table>
  );
});
export default JointGrid;
