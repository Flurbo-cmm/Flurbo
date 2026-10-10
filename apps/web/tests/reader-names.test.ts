import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SETTLEMENT_ADAPTERS } from '../server/settlement-rules.mjs';
import { credentialedReader, readerName } from '../src/reader-names.ts';

test('every reader has a plain name for members', () => {
  const expected: Record<string, string> = {
    'json-api.v1': 'Public JSON API', 'json-api.v2': 'Public JSON API', 'stat-table.v1': 'Official statistics table',
    'html-text.v1': 'Official web page', 'evm-rpc.v1': 'EVM chain RPC', 'proof-http.v1': 'Credentialed source with TLS proof',
    'pdf-text.v1': 'Official PDF document', 'xml-feed.v1': 'XML or RSS feed', 'json-record.v1': 'JSON record',
    'bls-employment-html.v1': 'BLS release page', 'fomc-statement-html.v1': 'FOMC statement page', 'usgs-earthquake-count.v1': 'USGS catalogue' };
  for (const [adapter, name] of Object.entries(expected)) assert.equal(readerName(adapter), name, adapter);
  for (const adapter of SETTLEMENT_ADAPTERS) assert.ok(adapter in expected, `${adapter} has no member name`);
});

test('a missing reader is Reality.eth and an unknown one is shown as written', () => {
  for (const missing of [undefined, null, '']) assert.equal(readerName(missing), 'Reality.eth');
  assert.equal(readerName('future-reader.v9'), 'future-reader.v9');
});

test('only the proof reader is credentialed', () => {
  assert.equal(credentialedReader('proof-http.v1'), true);
  for (const adapter of ['json-api.v1', 'json-api.v2', 'evm-rpc.v1', 'pdf-text.v1', 'xml-feed.v1', undefined, null, ''])
    assert.equal(credentialedReader(adapter as string), false);
});
