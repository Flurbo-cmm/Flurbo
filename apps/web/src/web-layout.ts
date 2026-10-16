export type WebNodeInput = { event: number; linked: boolean };
export type WebNodePosition = { event: number; x: number; y: number };

const INNER = 0.27, OUTER = 0.43;

// Questions with a priced link sit on the inner ring, the rest on the outer ring, each in event order from the top.
export function ringLayout(nodes: WebNodeInput[], size: number): WebNodePosition[] {
  const centre = size / 2;
  if (nodes.length === 1) return [{ event: nodes[0].event, x: centre, y: centre }];
  const place = (group: WebNodeInput[], radius: number) => group.map((node, i) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / group.length;
    return { event: node.event, x: centre + radius * size * Math.cos(angle), y: centre + radius * size * Math.sin(angle) };
  });
  const ordered = [...nodes].sort((a, b) => a.event - b.event);
  const placed = [...place(ordered.filter(n => n.linked), INNER), ...place(ordered.filter(n => !n.linked), OUTER)];
  return placed.sort((a, b) => a.event - b.event);
}

export const shortTitle = (question: string, words = 6, maxChars = Infinity) => {
  const parts = question.trim().split(/\s+/);
  let kept = parts.slice(0, words);
  while (kept.length > 1 && kept.join(' ').length > maxChars) kept = kept.slice(0, -1);
  return kept.length === parts.length ? question.trim() : kept.join(' ') + '...';
};

export const signedPercent = (tenths: number | null) =>
  tenths === null ? 'n/a' : `${tenths > 0 ? '+' : tenths < 0 ? '-' : ''}${(Math.abs(tenths) / 10).toFixed(1)}%`;
