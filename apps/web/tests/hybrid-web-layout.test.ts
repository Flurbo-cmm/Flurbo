import assert from 'node:assert/strict';
import test from 'node:test';
import { ringLayout, shortTitle, signedPercent, signedPoints } from '../src/web-layout.ts';

const nodes = (count: number, linked: (i: number) => boolean) =>
  Array.from({ length: count }, (_, event) => ({ event, linked: linked(event) }));
const radius = (p: { x: number; y: number }, size: number) => Math.hypot(p.x - size / 2, p.y - size / 2);

test('positions are deterministic for the same input', () => {
  const input = nodes(16, i => i % 3 === 0);
  assert.deepEqual(ringLayout(input, 600), ringLayout(input.map(n => ({ ...n })), 600));
});

test('linked nodes sit on the inner radius and unlinked on the outer', () => {
  const placed = ringLayout(nodes(16, i => i < 6), 600);
  const inner = placed.filter(p => p.event < 6).map(p => radius(p, 600));
  const outer = placed.filter(p => p.event >= 6).map(p => radius(p, 600));
  assert.ok(Math.max(...inner) < Math.min(...outer));
  assert.ok(Math.max(...inner) - Math.min(...inner) < 0.001);
  assert.ok(Math.max(...outer) - Math.min(...outer) < 0.001);
});

test('no two nodes are closer than size / 24', () => {
  for (const linked of [() => true, () => false, (i: number) => i % 2 === 0]) {
    const placed = ringLayout(nodes(16, linked), 480);
    for (let i = 0; i < placed.length; i += 1) for (let j = i + 1; j < placed.length; j += 1)
      assert.ok(Math.hypot(placed[i].x - placed[j].x, placed[i].y - placed[j].y) >= 480 / 24);
  }
});

test('a single node sits at the centre', () => {
  assert.deepEqual(ringLayout(nodes(1, () => false), 600), [{ event: 0, x: 300, y: 300 }]);
});

test('32 nodes still satisfy the spacing rule', () => {
  for (const linked of [() => true, () => false, (i: number) => i < 20]) {
    const placed = ringLayout(nodes(32, linked), 600);
    assert.equal(placed.length, 32);
    for (let i = 0; i < placed.length; i += 1) for (let j = i + 1; j < placed.length; j += 1)
      assert.ok(Math.hypot(placed[i].x - placed[j].x, placed[i].y - placed[j].y) >= 600 / 24);
  }
});

test('short titles keep whole words within the word and character limits', () => {
  assert.equal(shortTitle('Will it rain'), 'Will it rain');
  assert.equal(shortTitle('Will Solana outperform Ethereum this week?', 4), 'Will Solana outperform Ethereum...');
  assert.equal(shortTitle('Will Solana outperform Ethereum this week?', 4, 24), 'Will Solana outperform...');
  assert.equal(shortTitle('Extraordinarilylongsingleword beyond', 4, 5), 'Extraordinarilylongsingleword...');
});

test('signed percents show direction and one decimal', () => {
  assert.deepEqual([signedPercent(60), signedPercent(-30), signedPercent(0), signedPercent(null)], ['+6.0%', '-3.0%', '0.0%', 'n/a']);
});

test('signedPoints reads a difference as percentage points, not a relative percent', () => {
  assert.deepEqual([signedPoints(96), signedPoints(-30), signedPoints(0), signedPoints(null), signedPoints(5)], ['+9.6 pts', '-3.0 pts', '0.0 pts', 'n/a', '+0.5 pts']);
});
