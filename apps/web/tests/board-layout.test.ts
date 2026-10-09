import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boardCapacity, paginate } from '../src/board-layout.ts';

// Chrome: header, category bar, toolbar, legend, grid padding and pager, as laid out by the board.
const desktopChrome = 64 + 44 + 52 + 22 + 12 + 64;
const compactChrome = 56 + 43 + 106 + 4 + 56 + 8;

test('desktop capacities match the board at common sizes', () => {
  assert.deepEqual(boardCapacity({ width: 1360, height: 900, compact: false, chrome: desktopChrome }), { columns: 4, rows: 4, perPage: 16, fits: true });
  assert.deepEqual(boardCapacity({ width: 1200, height: 800, compact: false, chrome: desktopChrome }), { columns: 4, rows: 4, perPage: 16, fits: true });
  assert.deepEqual(boardCapacity({ width: 960, height: 768, compact: false, chrome: desktopChrome }), { columns: 3, rows: 3, perPage: 9, fits: true });
  assert.equal(boardCapacity({ width: 720, height: 1024, compact: false, chrome: desktopChrome - 8 }).columns, 2);
});

test('compact phones show one column of six or seven tiles', () => {
  const phone = boardCapacity({ width: 358, height: 844, compact: true, chrome: compactChrome });
  assert.equal(phone.columns, 1);
  assert.ok(phone.rows === 6 || phone.rows === 7, `rows ${phone.rows}`);
  assert.equal(phone.perPage, phone.rows);
  assert.equal(phone.fits, true);
});

test('short viewports fall back to a scrolling list', () => {
  assert.equal(boardCapacity({ width: 1220, height: 540, compact: false, chrome: desktopChrome }).fits, false);
  assert.equal(boardCapacity({ width: 1220, height: 500, compact: false, chrome: desktopChrome }).fits, false);
  const oneRow = boardCapacity({ width: 1220, height: 600, compact: false, chrome: desktopChrome + 200 });
  assert.equal(oneRow.rows < 2, true);
  assert.equal(oneRow.fits, false);
  assert.ok(boardCapacity({ width: 100, height: 100, compact: false, chrome: 400 }).columns >= 1);
});

test('paginate clamps the page and returns the right slice', () => {
  const items = Array.from({ length: 10 }, (_, i) => i);
  assert.deepEqual(paginate(items, 4, 1), { items: [0, 1, 2, 3], page: 1, pageCount: 3 });
  assert.deepEqual(paginate(items, 4, 3), { items: [8, 9], page: 3, pageCount: 3 });
  assert.deepEqual(paginate(items, 4, 9), { items: [8, 9], page: 3, pageCount: 3 });
  assert.deepEqual(paginate(items, 4, 0), { items: [0, 1, 2, 3], page: 1, pageCount: 3 });
  assert.deepEqual(paginate(items, 4, Number.NaN), { items: [0, 1, 2, 3], page: 1, pageCount: 3 });
  assert.deepEqual(paginate([], 4, 2), { items: [], page: 1, pageCount: 1 });
  assert.deepEqual(paginate(items, 0, 1).items.length, 10);
});
