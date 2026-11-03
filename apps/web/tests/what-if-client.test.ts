import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { clearWhatIfCache, echoesRequest, fetchWhatIf, whatIfKey, type WhatIf, type WhatIfInput } from '../src/what-if-client.ts';

const pool = '0x' + '5'.repeat(40);
const reply = (input: WhatIfInput, change: Partial<WhatIf> = {}): WhatIf => ({ schema: 'flurbo.hybrid-what-if.v1', pool, blockNumber: '1', blockHash: '0x' + '9'.repeat(64),
  observedAt: 1, closed: false, unit: 'tenths_of_percentage_point', given: [...input.given].sort((a, b) => a.eventIndex - b.eventIndex), givenChance: 500,
  questions: [], claim: input.claim ? { scope: 3, mask: '8', rule: input.claim.rule, legs: [...input.claim.legs].sort((a, b) => a.eventIndex - b.eventIndex),
    chance: 100, independent: 90, difference: 10, cells: [], priceable: true, addable: [] } : null, reasons: {}, ...change });
const server = (change: (input: WhatIfInput) => Partial<WhatIf> = () => ({})) => {
  const bodies: WhatIfInput[] = [];
  const fetcher = (async (_url: string, init: RequestInit) => {
    const input = JSON.parse(String(init.body)) as WhatIfInput;
    bodies.push(input);
    return { ok: true, json: async () => reply(input, change(input)) };
  }) as unknown as typeof fetch;
  return { fetcher, bodies };
};
beforeEach(() => clearWhatIfCache());

test('a response for another pool, other legs or another rule is rejected', async () => {
  const input: WhatIfInput = { given: [{ eventIndex: 0, side: 'yes' }], claim: { legs: [{ eventIndex: 1, side: 'no' }, { eventIndex: 2, side: 'yes' }], rule: 'OR' } };
  assert.ok(echoesRequest(reply(input), pool, input));
  assert.ok(echoesRequest(reply(input), pool.toUpperCase().replace('0X', '0x'), input));
  const wrong: Partial<WhatIf>[] = [{ pool: '0x' + '6'.repeat(40) }, { schema: 'flurbo.hybrid-what-if.v0' as never },
    { given: [{ eventIndex: 0, side: 'no' }] }, { given: [] }, { claim: null },
    { claim: { ...reply(input).claim!, rule: 'AND' } }, { claim: { ...reply(input).claim!, legs: [{ eventIndex: 1, side: 'yes' }, { eventIndex: 2, side: 'yes' }] } }];
  for (const change of wrong) {
    assert.equal(echoesRequest(reply(input, change), pool, input), false, JSON.stringify(change));
    const { fetcher } = server(() => change);
    await assert.rejects(fetchWhatIf(`${pool}-0`, pool, input, { fetcher }), /Invalid pool comparison/);
  }
  assert.equal(echoesRequest(reply({ given: [{ eventIndex: 0, side: 'yes' }] }), pool, { given: [{ eventIndex: 0, side: 'yes' }], claim: input.claim }), false);
  const failing = (async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch;
  await assert.rejects(fetchWhatIf(`${pool}-0`, pool, input, { fetcher: failing }), /could not load/);
});

test('the same request is served from the cache', async () => {
  const input: WhatIfInput = { given: [{ eventIndex: 3, side: 'no' }, { eventIndex: 1, side: 'yes' }] };
  const { fetcher, bodies } = server();
  let clock = 1_000;
  const options = { fetcher, now: () => clock };
  const first = await fetchWhatIf(`${pool}-0`, pool, input, options);
  const again = await fetchWhatIf(`${pool}-0`, pool, { given: [...input.given].reverse() }, options);
  assert.equal(again, first);
  assert.equal(bodies.length, 1);
  assert.deepEqual(bodies[0].given, [{ eventIndex: 1, side: 'yes' }, { eventIndex: 3, side: 'no' }]);
  assert.equal(whatIfKey(pool, input), whatIfKey(pool.toUpperCase().replace('0X', '0x'), { given: [...input.given].reverse() }));
  await fetchWhatIf(`${pool}-0`, pool, input, { ...options, fresh: true });
  assert.equal(bodies.length, 2);
  clock += 31_000;
  await fetchWhatIf(`${pool}-0`, pool, input, options);
  assert.equal(bodies.length, 3);
  for (let i = 0; i < 25; i += 1) await fetchWhatIf(`${pool}-0`, pool, { given: [{ eventIndex: i % 32, side: i < 16 ? 'yes' : 'no' }] }, options);
  assert.equal(bodies.length, 28);
  await fetchWhatIf(`${pool}-0`, pool, input, options);
  assert.equal(bodies.length, 29);
});
