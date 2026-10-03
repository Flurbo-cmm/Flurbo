import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { envioProxy } from '../server/envio-proxy.mjs';

const ENDPOINT = 'https://indexer.dev.hyperindex.xyz/84870f9/v1/graphql';
const POOL = '0x160647d16405f44989c56b83609a171247068dcc';
const TRADER = '0x1111111111111111111111111111111111111111';

function request(body: object, method = 'POST') {
  const stream = Readable.from([JSON.stringify(body)]) as Readable & { method: string };
  stream.method = method;
  return stream;
}

function response() {
  const result = { status: 0, body: '' };
  return {
    result,
    writeHead(status: number) { result.status = status; },
    end(body?: Buffer | string) { result.body = body?.toString() || ''; }
  };
}

test('proxy sends only a server-owned, bounded trade query without credentials', async () => {
  const res = response();
  let forwarded: any;
  await envioProxy(request({ kind: 'trades', pool: POOL.toUpperCase().replace('0X', '0x'), limit: 5 }), res,
    ENDPOINT, async (url: URL, options: any) => {
      forwarded = { url: url.href, headers: options.headers, body: JSON.parse(options.body) };
      return new Response(JSON.stringify({ data: { Trade: [] } }), { status: 200 });
    });
  assert.equal(res.result.status, 200);
  assert.equal(forwarded.url, ENDPOINT);
  assert.deepEqual(forwarded.headers, { 'Content-Type': 'application/json' });
  assert.match(forwarded.body.query, /Trade\(where:/);
  assert.deepEqual(forwarded.body.variables, { pool: POOL, limit: 5 });
  assert.deepEqual(JSON.parse(res.result.body), { data: { Trade: [] } });
});

test('proxy builds a fixed trader-position ID', async () => {
  const res = response();
  let forwarded: any;
  await envioProxy(request({ kind: 'position', pool: POOL, trader: TRADER }), res, ENDPOINT,
    async (_url: URL, options: any) => {
      forwarded = JSON.parse(options.body);
      return new Response(JSON.stringify({ data: { TraderPosition_by_pk: null } }), { status: 200 });
    });
  assert.equal(res.result.status, 200);
  assert.equal(forwarded.variables.id, `${TRADER}-${POOL}`);
  assert.match(forwarded.query, /TraderPosition_by_pk/);
});

test('proxy batches bounded portfolio positions with a server-owned query', async () => {
  const res = response();
  let forwarded: any;
  await envioProxy(request({ kind: 'portfolio', pools: [POOL, POOL], traders: [TRADER] }), res, ENDPOINT,
    async (_url: URL, options: any) => {
      forwarded = JSON.parse(options.body);
      return new Response(JSON.stringify({ data: { TraderPosition: [] } }), { status: 200 });
    });
  assert.equal(res.result.status, 200);
  assert.match(forwarded.query, /TraderPosition\(where:/);
  assert.deepEqual(forwarded.variables, { pools: [POOL], traders: [TRADER] });
});

test('proxy refuses arbitrary queries, out-of-range limits, and unsafe endpoints', async () => {
  for (const body of [
    { kind: 'trades', pool: POOL, limit: 21 },
    { kind: 'trades', pool: POOL, limit: 5, query: 'mutation Delete { x }' },
    { kind: 'position', pool: POOL, trader: 'not-an-address' },
    { kind: 'portfolio', pools: [POOL], traders: [TRADER], query: 'mutation Delete { x }' },
    { kind: 'portfolio', pools: Array(26).fill(POOL), traders: [TRADER] }
  ]) {
    const res = response();
    await envioProxy(request(body), res, ENDPOINT, async () => { throw Error('Should not fetch'); });
    assert.equal(res.result.status, 400);
  }
  for (const endpoint of ['http://127.0.0.1:8080/v1/graphql', 'https://evil.example/v1/graphql']) {
    const res = response();
    await envioProxy(request({ kind: 'trades', pool: POOL, limit: 5 }), res, endpoint);
    assert.equal(res.result.status, 503);
  }
  const wrongMethod = response();
  await envioProxy(request({}, 'GET'), wrongMethod, ENDPOINT);
  assert.equal(wrongMethod.result.status, 405);
});
