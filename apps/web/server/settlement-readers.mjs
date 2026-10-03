import { compareDecimal, decimal, digest, GENERAL_ADAPTERS } from './settlement-rules.mjs';

// General settlement readers. Each market's rule names one reader and configures it; that configuration is part
// of the rule hash committed on-chain, so it cannot change after deployment. Readers only turn a retained source
// response into a value: capture timing, evidence archiving, evaluation and proposals are shared with every
// other adapter. A value that is not there yet (a release not published, a block not produced) is an issue, so
// the capture is not retained and the bot keeps checking until the rule's cutoff. Nothing here guesses.
//
//   json-api.v1    any public JSON API: a value, or count/sum/max/min/only over a filtered list
//   stat-table.v1  official statistics: CSV rows, SDMX-JSON series, JSON-stat datasets
//   html-text.v1   official pages without data: required anchors plus one pattern matching exactly once
//   evm-rpc.v1     any EVM chain through public RPC: contract call, balance, nonce, block field at a time,
//                  or transaction/log counts between two times, with the boundary blocks kept as evidence
export { GENERAL_ADAPTERS };

const issue = reason => { throw Object.assign(Error(reason), { reason }); };
const invalid = message => { throw Error(message); };
const plain = (value, keys, required = []) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => keys.includes(key)) && required.every(key => Object.hasOwn(value, key));
const text = (value, max = 500) => typeof value === 'string' && value.length > 0 && value.length <= max;
const pointer = value => typeof value === 'string' && value.length <= 300 && /^(?:\/(?:[^~/]|~[01])*)*$/.test(value);
const address = value => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
const TIME_FORMATS = ['unix-seconds', 'unix-millis', 'iso-datetime', 'date'];
const OPS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte'];
const MAX_EVM_CALLS = 1000;

// ---------- exact JSON ----------
// JSON numbers keep their exact text, so 3.6123 is never rounded through a float. Duplicate keys are refused.
class ExactNumber { constructor(raw) { this.raw = raw; } }
export function parseExactJSON(input) {
  const body = input.startsWith('﻿') ? input.slice(1) : input;
  let i = 0;
  const fail = () => issue('EXTRACTION_INVALID_JSON');
  const space = () => { while (i < body.length && ' \n\r\t'.includes(body[i])) i++; };
  const token = pattern => { pattern.lastIndex = i; const match = pattern.exec(body); if (!match) fail(); i = pattern.lastIndex; return match[0]; };
  const STRING = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y, NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  const value = depth => {
    if (depth > 64) issue('EXTRACTION_TOO_DEEP');
    space();
    const c = body[i];
    if (c === '{') {
      i++; const object = Object.create(null); space();
      if (body[i] === '}') { i++; return object; }
      for (;;) {
        space(); if (body[i] !== '"') fail();
        const key = JSON.parse(token(STRING));
        if (Object.hasOwn(object, key)) issue('EXTRACTION_DUPLICATE_FIELD');
        space(); if (body[i++] !== ':') fail();
        object[key] = value(depth + 1); space();
        if (body[i] === ',') { i++; continue; }
        if (body[i] === '}') { i++; return object; }
        fail();
      }
    }
    if (c === '[') {
      i++; const list = []; space();
      if (body[i] === ']') { i++; return list; }
      for (;;) { list.push(value(depth + 1)); space(); if (body[i] === ',') { i++; continue; } if (body[i] === ']') { i++; return list; } fail(); }
    }
    if (c === '"') return JSON.parse(token(STRING));
    for (const [word, result] of [['true', true], ['false', false], ['null', null]]) if (body.startsWith(word, i)) { i += word.length; return result; }
    return new ExactNumber(token(NUMBER));
  };
  const result = value(0); space();
  if (i !== body.length) fail();
  return result;
}
function resolve(node, path, missing = () => issue('EXTRACTION_MISSING_FIELD')) {
  if (path === '') return node;
  for (const part of path.slice(1).split('/').map(t => t.replace(/~1/g, '/').replace(/~0/g, '~'))) {
    if (Array.isArray(node)) { if (!/^(?:0|[1-9]\d*)$/.test(part) || Number(part) >= node.length) return missing(); node = node[Number(part)]; }
    else if (node && typeof node === 'object' && !(node instanceof ExactNumber) && Object.hasOwn(node, part)) node = node[part];
    else return missing();
  }
  return node;
}
const scalarText = node => node instanceof ExactNumber ? node.raw : typeof node === 'string' ? node : typeof node === 'boolean' ? String(node)
  : node === null ? 'null' : issue('EXTRACTION_NOT_A_VALUE');

// ---------- exact decimals ----------
export function exactDecimal(raw) {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(String(raw).trim());
  if (!match) issue('VALUE_INVALID');
  const [, sign, whole, fraction = '', exponent = '0'] = match, shift = Number(exponent);
  if (!Number.isSafeInteger(shift) || Math.abs(shift) > 60) issue('VALUE_INVALID');
  let digits = whole + fraction, point = whole.length + shift;
  if (point <= 0) { digits = '0'.repeat(1 - point) + digits; point = 1; } else if (point > digits.length) digits += '0'.repeat(point - digits.length);
  const integer = digits.slice(0, point).replace(/^0+(?=\d)/, ''), decimals = digits.slice(point).replace(/0+$/, '');
  if (decimals.length > 18 || integer.length > 36) issue('VALUE_PRECISION_UNSUPPORTED');
  const out = (sign && /[1-9]/.test(integer + decimals) ? '-' : '') + integer + (decimals ? '.' + decimals : '');
  decimal(out);
  return out;
}
const scaled = (value, places) => places ? exactDecimal(`${value}e-${places}`) : value;
function fromUnits(coefficient, places) {
  const negative = coefficient < 0n, digits = (negative ? -coefficient : coefficient).toString().padStart(places + 1, '0');
  return exactDecimal(`${negative ? '-' : ''}${digits.slice(0, digits.length - places)}${places ? '.' + digits.slice(digits.length - places) : ''}`);
}
function addDecimal(a, b) {
  const x = decimal(a), y = decimal(b), s = Math.max(x.scale, y.scale);
  return fromUnits(x.coefficient * 10n ** BigInt(s - x.scale) + y.coefficient * 10n ** BigInt(s - y.scale), s);
}

// ---------- values and times ----------
function timeValue(node, format) {
  const s = node instanceof ExactNumber ? node.raw : typeof node === 'string' ? node.trim() : issue('TIME_INVALID');
  let seconds = NaN;
  if (format === 'unix-seconds' && /^\d{1,12}$/.test(s)) seconds = Number(s);
  else if (format === 'unix-millis' && /^\d{1,15}$/.test(s)) seconds = Math.floor(Number(s) / 1000);
  else if (format === 'iso-datetime' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/.test(s)) seconds = Math.floor(Date.parse(s) / 1000);
  else if (format === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(s)) seconds = Date.parse(`${s}T00:00:00Z`) / 1000;
  if (!Number.isSafeInteger(seconds) || seconds < 0) issue('TIME_INVALID');
  return seconds;
}
function valueOf(node, rule, { grouping = 'none' } = {}) {
  const r = rule.source.reader, type = rule.decision.type;
  if (node === null || node === undefined) issue('VALUE_MISSING');
  if (type === 'number') {
    const raw = node instanceof ExactNumber ? node.raw : typeof node === 'string' ? (grouping === 'comma' ? node.replace(/,(?=\d{3}(?:\D|$))/g, '') : node) : issue('VALUE_INVALID');
    return scaled(exactDecimal(raw), r.scale ?? 0);
  }
  if (type === 'timestamp') return timeValue(node, r.valueFormat);
  const value = node instanceof ExactNumber ? exactDecimal(node.raw) : typeof node === 'boolean' ? String(node) : node;
  if (!text(value)) issue('VALUE_INVALID');
  return value;
}
function matches(node, filter) {
  if (node === undefined || node === null || typeof node === 'object' && !(node instanceof ExactNumber)) return false;
  const actual = scalarText(node);
  if (filter.op === 'eq') return actual === filter.value;
  if (filter.op === 'ne') return actual !== filter.value;
  let comparison; try { comparison = compareDecimal(exactDecimal(actual), filter.value); } catch { return false; }
  return { gt: comparison > 0, gte: comparison >= 0, lt: comparison < 0, lte: comparison <= 0 }[filter.op];
}

// ---------- configuration checks (part of validateSettlementRule) ----------
function checkPublished(published, key) {
  if (published === undefined) return;
  if (!plain(published, [key, 'format'], [key, 'format']) || !TIME_FORMATS.includes(published.format)) invalid('Invalid publication time field');
  if (key === 'path' ? !pointer(published.path) : key === 'pattern' ? !checkPattern(published.pattern) : !text(published[key], 200)) invalid('Invalid publication time field');
}
function checkPattern(pattern) {
  if (!text(pattern, 300) || /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)[+*{]/.test(pattern) || /\\[1-9]|\(\?<[=!]/.test(pattern)) return false;
  let groups;
  try { groups = new RegExp(`${pattern}|`).exec('').length - 1; } catch { return false; }
  return groups === 1;
}
export function validateReaderConfig(rule) {
  const { adapter, reader: r, urls } = rule.source, type = rule.decision.type;
  if (!r || typeof r !== 'object' || Array.isArray(r)) invalid('Reader configuration required');
  if (r.scale !== undefined && (type !== 'number' || !Number.isSafeInteger(r.scale) || r.scale < 0 || r.scale > 36)) invalid('Invalid scale');
  if ((type === 'timestamp') !== (r.valueFormat !== undefined) || (r.valueFormat !== undefined && !TIME_FORMATS.includes(r.valueFormat))) invalid('Timestamp values need a value format');
  if (rule.vintage === 'initial-with-corrections') invalid('General readers use first-observed-snapshot or initial');
  if (adapter === 'json-api.v1') {
    if (!plain(r, ['select', 'aggregate', 'field', 'filter', 'checks', 'publishedAt', 'scale', 'valueFormat'], ['select', 'aggregate'])
      || !pointer(r.select) || !['value', 'only', 'count', 'sum', 'max', 'min'].includes(r.aggregate)) invalid('Invalid JSON reader');
    const needsField = ['only', 'sum', 'max', 'min'].includes(r.aggregate);
    if (needsField !== (r.field !== undefined) || (needsField && !pointer(r.field))) invalid('Invalid JSON reader field');
    if (['count', 'sum', 'max', 'min'].includes(r.aggregate) && type !== 'number') invalid('Counts and totals are numbers');
    if (r.aggregate === 'value' && r.filter !== undefined) invalid('Filters apply to lists');
    if (r.filter !== undefined && (!Array.isArray(r.filter) || !r.filter.length || r.filter.length > 8 || r.filter.some(f => !plain(f, ['path', 'op', 'value'], ['path', 'op', 'value'])
      || !pointer(f.path) || !OPS.includes(f.op) || !text(f.value, 200) || (!['eq', 'ne'].includes(f.op) && (() => { try { decimal(f.value); return false; } catch { return true; } })())))) invalid('Invalid JSON reader filter');
    if (r.checks !== undefined && (!Array.isArray(r.checks) || !r.checks.length || r.checks.length > 8 || r.checks.some(c => !plain(c, ['path', 'equals'], ['path', 'equals']) || !pointer(c.path) || !text(c.equals)))) invalid('Invalid JSON reader checks');
    checkPublished(r.publishedAt, 'path');
  } else if (adapter === 'stat-table.v1') {
    if (!plain(r, ['format', 'delimiter', 'select', 'valueColumn', 'period', 'missing', 'publishedAt', 'scale', 'valueFormat'], ['format', 'select'])
      || !['csv', 'sdmx-json', 'json-stat'].includes(r.format) || !plain(r.select, Object.keys(r.select || {}))
      || Object.keys(r.select).length > 12 || Object.entries(r.select).some(([k, v]) => !text(k, 200) || !text(v, 200))) invalid('Invalid statistics reader');
    if (r.format === 'csv') {
      if (!text(r.valueColumn, 200) || r.period !== undefined || !Object.keys(r.select).length || (r.delimiter !== undefined && ![',', ';', '\t'].includes(r.delimiter))
        || (r.missing !== undefined && (!Array.isArray(r.missing) || r.missing.length > 10 || r.missing.some(m => typeof m !== 'string' || m.length > 20)))) invalid('Invalid CSV reader');
      checkPublished(r.publishedAt, 'column');
    } else {
      if (r.valueColumn !== undefined || r.delimiter !== undefined || r.missing !== undefined || r.publishedAt !== undefined) invalid('Only CSV uses columns');
      if (r.format === 'sdmx-json' ? !text(r.period, 50) : (r.period !== undefined || !Object.keys(r.select).length)) invalid('Invalid SDMX or JSON-stat selection');
    }
  } else if (adapter === 'html-text.v1') {
    if (!plain(r, ['anchors', 'pattern', 'grouping', 'publishedAt', 'scale', 'valueFormat'], ['anchors', 'pattern'])
      || !Array.isArray(r.anchors) || !r.anchors.length || r.anchors.length > 8 || r.anchors.some(a => typeof a !== 'string' || a.length < 3 || a.length > 300)
      || !checkPattern(r.pattern) || (r.grouping !== undefined && !['none', 'comma'].includes(r.grouping))) invalid('Invalid page reader');
    checkPublished(r.publishedAt, 'pattern');
  } else if (adapter === 'evm-rpc.v1') {
    if (!plain(r, ['chainId', 'at', 'until', 'metric', 'call', 'address', 'field', 'logs', 'stride', 'finalitySeconds', 'scale'], ['chainId', 'at', 'metric', 'finalitySeconds'])
      || !Number.isSafeInteger(r.chainId) || r.chainId < 1 || !Number.isSafeInteger(r.at) || r.at < 1
      || !Number.isSafeInteger(r.finalitySeconds) || r.finalitySeconds < 0 || r.finalitySeconds > 86_400
      || type !== 'number' || rule.vintage !== 'first-observed-snapshot' || urls.length > 3) invalid('Invalid chain reader');
    const range = ['tx-count', 'log-count'].includes(r.metric);
    if (range !== (r.until !== undefined) || (range && (!Number.isSafeInteger(r.until) || r.until <= r.at || r.until - r.at > 7 * 86_400))) invalid('Range metrics need a later until time');
    if (rule.timing.scheduledAt < (r.until ?? r.at)) invalid('Chain values are captured only after their observation time');
    const allowed = { call: ['call'], balance: ['address'], nonce: ['address'], 'block-field': ['field'], 'tx-count': ['stride'], 'log-count': ['logs'] }[r.metric];
    if (!allowed) invalid('Unsupported chain metric');
    for (const key of ['call', 'address', 'field', 'logs', 'stride']) if (r[key] !== undefined && !allowed.includes(key)) invalid('Unexpected chain metric setting');
    if (r.metric === 'call' && (!plain(r.call, ['to', 'data', 'returns'], ['to', 'data', 'returns']) || !address(r.call.to)
      || !/^0x(?:[0-9a-fA-F]{2}){4,1024}$/.test(r.call.data) || !['uint256', 'int256'].includes(r.call.returns))) invalid('Invalid contract call');
    if (['balance', 'nonce'].includes(r.metric) && !address(r.address)) invalid('Invalid address');
    if (r.metric === 'block-field' && !['gasUsed', 'gasLimit', 'baseFeePerGas', 'transactions'].includes(r.field)) invalid('Invalid block field');
    if (r.metric === 'tx-count' && r.stride !== undefined && (!Number.isSafeInteger(r.stride) || r.stride < 1 || r.stride > 10_000)) invalid('Invalid stride');
    if (r.metric === 'log-count' && (!plain(r.logs, ['address', 'topics'], ['address']) || !address(r.logs.address) || (r.logs.topics !== undefined
      && (!Array.isArray(r.logs.topics) || r.logs.topics.length > 4 || r.logs.topics.some(t => t !== null && !/^0x[0-9a-fA-F]{64}$/.test(t)))))) invalid('Invalid log filter');
  } else invalid('Unknown general reader');
  if (rule.vintage === 'initial' && !r.publishedAt) invalid('The initial vintage needs a publication time from the source');
  return r;
}

// ---------- readers ----------
function jsonApi(body, rule) {
  const r = rule.source.reader, doc = parseExactJSON(body);
  for (const check of r.checks ?? []) if (scalarText(resolve(doc, check.path)) !== check.equals) issue('OBSERVATION_IDENTITY_MISMATCH');
  const node = resolve(doc, r.select);
  let value;
  if (r.aggregate === 'value') value = valueOf(node, rule);
  else {
    if (!Array.isArray(node)) issue('EXTRACTION_NOT_A_LIST');
    if (node.length > 50_000) issue('EXTRACTION_TOO_LARGE');
    const items = node.filter(item => (r.filter ?? []).every(f => matches(resolve(item, f.path, () => undefined), f)));
    if (r.aggregate === 'count') value = scaled(String(items.length), r.scale ?? 0);
    else if (r.aggregate === 'only') { if (items.length !== 1) issue('EXTRACTION_AMBIGUOUS_OR_MISSING'); value = valueOf(resolve(items[0], r.field), rule); }
    else {
      if (!items.length) issue('VALUE_MISSING');
      const values = items.map(item => { const v = resolve(item, r.field); return exactDecimal(v instanceof ExactNumber ? v.raw : typeof v === 'string' ? v : issue('VALUE_INVALID')); });
      const total = r.aggregate === 'sum' ? values.reduce(addDecimal)
        : values.reduce((a, b) => (compareDecimal(a, b) >= 0) === (r.aggregate === 'max') ? a : b);
      value = scaled(total, r.scale ?? 0);
    }
  }
  return { value, publishedAt: r.publishedAt ? timeValue(resolve(doc, r.publishedAt.path), r.publishedAt.format) : null };
}

function parseCsv(input, delimiter) {
  const body = input.startsWith('﻿') ? input.slice(1) : input, rows = [];
  let row = [], field = '', quoted = false, i = 0, started = false;
  while (i < body.length) {
    const c = body[i];
    if (quoted) {
      if (c === '"') { if (body[i + 1] === '"') { field += '"'; i += 2; continue; } quoted = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"' && !started) { quoted = true; started = true; i++; continue; }
    if (c === delimiter) { row.push(field); field = ''; started = false; i++; continue; }
    if (c === '\r' || c === '\n') { row.push(field); rows.push(row); row = []; field = ''; started = false; i += c === '\r' && body[i + 1] === '\n' ? 2 : 1; continue; }
    field += c; started = true; i++;
  }
  if (quoted) issue('EXTRACTION_INVALID_CSV');
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  if (rows.length > 200_000) issue('EXTRACTION_TOO_LARGE');
  return rows.filter(r => r.length > 1 || r[0] !== '');
}
function statTable(body, rule, contentType) {
  const r = rule.source.reader;
  if (r.format === 'csv') {
    if (!/^(?:text\/csv|text\/plain|application\/csv|application\/vnd\.ms-excel|application\/octet-stream)(?:;|$)/i.test(contentType || '')) issue('CONTENT_TYPE_MISMATCH');
    const [header, ...rows] = parseCsv(body, r.delimiter ?? ','), columns = header?.map(h => h.trim()) ?? [];
    if (new Set(columns).size !== columns.length) issue('EXTRACTION_DUPLICATE_FIELD');
    const index = name => { const at = columns.indexOf(name); if (at < 0) issue('EXTRACTION_MISSING_FIELD'); return at; };
    const selected = Object.entries(r.select).map(([column, value]) => [index(column), value]), valueAt = index(r.valueColumn);
    const found = rows.filter(row => selected.every(([at, value]) => (row[at] ?? '').trim() === value));
    if (!found.length) issue('VALUE_MISSING');
    if (found.length > 1) issue('EXTRACTION_AMBIGUOUS_OR_MISSING');
    const cell = (found[0][valueAt] ?? '').trim();
    if ((r.missing ?? ['', '.', 'NA', 'NaN', ':', 'null']).includes(cell)) issue('VALUE_MISSING');
    return { value: valueOf(cell, rule), publishedAt: r.publishedAt ? timeValue((found[0][index(r.publishedAt.column)] ?? '').trim(), r.publishedAt.format) : null };
  }
  if (!/^application\/(?:json|[^;]+\+json)(?:;|$)/i.test(contentType || '')) issue('CONTENT_TYPE_MISMATCH');
  const doc = parseExactJSON(body), n = x => x instanceof ExactNumber ? Number(x.raw) : issue('STRUCTURE_INVALID');
  if (r.format === 'sdmx-json') {
    const data = doc.data ?? doc, sets = data.dataSets, structure = data.structures?.[0] ?? doc.structure ?? data.structure;
    const seriesDims = structure?.dimensions?.series ?? [], obsDims = structure?.dimensions?.observation;
    if (!Array.isArray(sets) || sets.length !== 1 || !Array.isArray(seriesDims) || !Array.isArray(obsDims) || obsDims.length !== 1) issue('SDMX_STRUCTURE_INVALID');
    if (Object.keys(r.select).some(k => !seriesDims.some(d => d?.id === k))) issue('OBSERVATION_IDENTITY_MISMATCH');
    const key = seriesDims.map(d => {
      if (!Array.isArray(d?.values)) issue('SDMX_STRUCTURE_INVALID');
      if (Object.hasOwn(r.select, d.id)) { const at = d.values.findIndex(v => v?.id === r.select[d.id]); if (at < 0) issue('VALUE_MISSING'); return at; }
      if (d.values.length !== 1) issue('SDMX_SERIES_AMBIGUOUS');
      return 0;
    }).join(':');
    const series = sets[0].series?.[key], time = obsDims[0].values?.findIndex?.(v => v?.id === r.period) ?? -1;
    if (!series || time < 0) issue('VALUE_MISSING');
    const observation = series.observations?.[String(time)];
    return { value: valueOf(Array.isArray(observation) ? observation[0] : undefined, rule), publishedAt: null };
  }
  if (doc.class !== 'dataset' || !Array.isArray(doc.id) || !Array.isArray(doc.size) || doc.id.length !== doc.size.length) issue('JSONSTAT_STRUCTURE_INVALID');
  if (Object.keys(r.select).some(k => !doc.id.includes(k))) issue('OBSERVATION_IDENTITY_MISMATCH');
  let position = 0;
  doc.id.forEach((dimension, k) => {
    const size = n(doc.size[k]), index = doc.dimension?.[dimension]?.category?.index;
    let at;
    if (Object.hasOwn(r.select, dimension)) {
      const want = r.select[dimension];
      at = Array.isArray(index) ? index.indexOf(want) : index && Object.hasOwn(index, want) ? n(index[want]) : -1;
      if (at < 0 || at >= size) issue('VALUE_MISSING');
    } else if (size === 1) at = 0;
    else issue('JSONSTAT_DIMENSION_AMBIGUOUS');
    position = position * size + at;
  });
  const values = doc.value, node = Array.isArray(values) ? values[position] : values && Object.hasOwn(values, String(position)) ? values[String(position)] : undefined;
  return { value: valueOf(node, rule), publishedAt: null };
}

export function readableText(body) {
  return body.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, h) => String.fromCodePoint(Number.parseInt(h, 16))).replace(/&#(\d{1,7});/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&nbsp;/gi, ' ').replace(/&ndash;|&mdash;|&minus;/gi, '-').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&amp;/gi, '&')
    .replace(/[   ]/g, ' ').replace(/[‐-―−]/g, '-').replace(/\s+/g, ' ').trim();
}
function htmlText(body, rule, contentType) {
  const r = rule.source.reader;
  if (!/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(contentType || '')) issue('CONTENT_TYPE_MISMATCH');
  const page = readableText(body);
  if (r.anchors.some(anchor => !page.includes(anchor))) issue('OBSERVATION_IDENTITY_MISMATCH');
  const once = pattern => { const found = [...page.matchAll(new RegExp(pattern, 'g'))].slice(0, 2); if (found.length !== 1) issue('EXTRACTION_AMBIGUOUS_OR_MISSING'); return found[0][1]; };
  return { value: valueOf(once(r.pattern), rule, { grouping: r.grouping }), publishedAt: r.publishedAt ? timeValue(once(r.publishedAt.pattern), r.publishedAt.format) : null };
}

// ---------- EVM chains ----------
const hex = n => '0x' + BigInt(n).toString(16);
const quantity = value => { if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(value)) issue('EVM_RESPONSE_INVALID'); return BigInt(value); };
function metricRequests(r, first, end) {
  const at = hex(first);
  if (r.metric === 'call') return [['eth_call', [{ to: r.call.to.toLowerCase(), data: r.call.data.toLowerCase() }, at]]];
  if (r.metric === 'balance') return [['eth_getBalance', [r.address.toLowerCase(), at]]];
  if (r.metric === 'nonce') return [['eth_getTransactionCount', [r.address.toLowerCase(), at]]];
  if (r.metric === 'block-field') return [];
  const calls = [];
  if (r.metric === 'tx-count') for (let n = first; n < end; n += r.stride ?? 1) calls.push(['eth_getBlockTransactionCountByNumber', [hex(n)]]);
  else for (let n = first; n < end; n += 100) calls.push(['eth_getLogs', [{ address: r.logs.address.toLowerCase(), ...(r.logs.topics ? { topics: r.logs.topics.map(t => t && t.toLowerCase()) } : {}), fromBlock: hex(n), toBlock: hex(Math.min(end, n + 100) - 1) }]]);
  if (calls.length > MAX_EVM_CALLS) issue('EVM_RANGE_TOO_LARGE');
  return calls;
}
function checkBoundary(before, block, target) {
  for (const b of [before, block]) if (!b || typeof b.hash !== 'string' || typeof b.parentHash !== 'string') issue('EVM_RESPONSE_INVALID');
  if (quantity(before.number) + 1n !== quantity(block.number) || block.parentHash.toLowerCase() !== before.hash.toLowerCase()
    || !(quantity(before.timestamp) < BigInt(target) && quantity(block.timestamp) >= BigInt(target))) issue('EVM_BOUNDARY_INVALID');
  return Number(quantity(block.number));
}
function evmRpc(body, rule, capture) {
  const r = rule.source.reader;
  let bundle; try { bundle = JSON.parse(body); } catch { issue('EXTRACTION_INVALID_JSON'); }
  if (bundle?.schema !== 'flurbo.evm-capture.v1' || bundle.rpc !== capture.requestedUrl || bundle.chainId !== r.chainId || !Array.isArray(bundle.exchanges)) issue('EVM_CAPTURE_INVALID');
  let next = 0;
  const take = (method, params) => {
    const exchange = bundle.exchanges[next++];
    if (!exchange || exchange.request?.method !== method || JSON.stringify(exchange.request.params) !== JSON.stringify(params)
      || exchange.response?.id !== exchange.request.id || exchange.response.error || !Object.hasOwn(exchange.response, 'result')) issue('EVM_CAPTURE_INVALID');
    return exchange.response.result;
  };
  if (quantity(take('eth_chainId', [])) !== BigInt(r.chainId)) issue('EVM_CHAIN_MISMATCH');
  const blockPair = () => {
    const before = bundle.exchanges[next]?.request?.params?.[0], a = take('eth_getBlockByNumber', [before, false]), b = take('eth_getBlockByNumber', [hex(quantity(before) + 1n), false]);
    if (quantity(a?.number) !== quantity(before) || quantity(b?.number) !== quantity(before) + 1n) issue('EVM_BOUNDARY_INVALID');
    return [a, b];
  };
  const [beforeStart, start] = blockPair(), first = checkBoundary(beforeStart, start, r.at);
  let end = null, last = start;
  if (r.until !== undefined) { const [beforeEnd, endBlock] = blockPair(); end = checkBoundary(beforeEnd, endBlock, r.until); if (end <= first) issue('EVM_BOUNDARY_INVALID'); last = endBlock; }
  let total;
  if (r.metric === 'block-field') {
    const field = start[r.field];
    total = r.field === 'transactions' ? (Array.isArray(field) ? BigInt(field.length) : issue('EVM_RESPONSE_INVALID')) : quantity(field);
  } else {
    const results = metricRequests(r, first, end).map(([method, params]) => take(method, params));
    if (r.metric === 'log-count') total = results.reduce((sum, logs) => { if (!Array.isArray(logs) || logs.some(l => l?.removed === true)) issue('EVM_RESPONSE_INVALID'); return sum + BigInt(logs.length); }, 0n);
    else if (r.metric === 'call') {
      const word = results[0];
      if (typeof word !== 'string' || !/^0x[0-9a-fA-F]{64}/.test(word)) issue('EVM_RESPONSE_INVALID');
      total = BigInt('0x' + word.slice(2, 66));
      if (r.call.returns === 'int256' && total >= 2n ** 255n) total -= 2n ** 256n;
    } else total = results.reduce((sum, value) => sum + quantity(value), 0n);
  }
  if (next !== bundle.exchanges.length) issue('EVM_CAPTURE_INVALID');
  if (capture.fetchedAt - Number(quantity(last.timestamp)) < r.finalitySeconds) issue('EVM_NOT_FINAL');
  return { value: fromUnits(total, r.scale ?? 0), publishedAt: null };
}

const pause = ms => new Promise(done => setTimeout(done, ms));
// Public RPCs rate-limit bursts. A refused or overloaded call is retried a few times with backoff; anything else
// fails the capture, and the bot tries again on its next cycle.
async function rpc(url, method, params, request, id, attempt = 0) {
  const response = await request(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(12_000),
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
  if ([429, 502, 503, 504].includes(response.status) && attempt < 5) {
    await response.body?.cancel?.().catch?.(() => {});
    const wait = Number(response.headers?.get?.('retry-after'));
    await pause(Number.isFinite(wait) && wait > 0 && wait <= 10 ? wait * 1000 : 400 * 2 ** attempt);
    return rpc(url, method, params, request, id, attempt + 1);
  }
  if (response.status !== 200 || response.redirected) issue('SOURCE_FETCH_FAILED');
  const raw = await response.arrayBuffer();
  if (raw.byteLength > 2_000_000) issue('SOURCE_TOO_LARGE');
  let parsed; try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); } catch { issue('EVM_RESPONSE_INVALID'); }
  if (parsed?.id !== id || parsed.jsonrpc !== '2.0') issue('EVM_RESPONSE_INVALID');
  if (parsed.error || !Object.hasOwn(parsed, 'result')) issue('EVM_RPC_ERROR');
  return parsed;
}
// Finds the first block at or after each time (unrecorded probes), then records only the evidence the reader
// re-checks: chain ID, the two blocks around each boundary, and the metric calls.
export async function retrieveEvmCapture(rule, url, { request = fetch, now = () => Math.floor(Date.now() / 1000) } = {}) {
  const r = rule.source.reader, exchanges = [];
  let id = 1;
  const record = async (method, params) => { const req = { jsonrpc: '2.0', id: id++, method, params }; const res = await rpc(url, method, params, request, req.id); exchanges.push({ request: req, response: res }); return res.result; };
  const probe = async n => { const block = (await rpc(url, 'eth_getBlockByNumber', [hex(n), false], request, id++)).result; if (!block) issue('EVM_BLOCK_NOT_YET_AVAILABLE'); return Number(quantity(block.timestamp)); };
  if (quantity(await record('eth_chainId', [])) !== BigInt(r.chainId)) issue('EVM_CHAIN_MISMATCH');
  const head = (await rpc(url, 'eth_getBlockByNumber', ['latest', false], request, id++)).result, headNumber = Number(quantity(head?.number));
  if (Number(quantity(head.timestamp)) < (r.until ?? r.at)) issue('EVM_BLOCK_NOT_YET_AVAILABLE');
  const firstAtOrAfter = async target => {
    let high = headNumber, low = -1, step = 1;
    for (;;) {
      const n = Math.max(0, high - step);
      if (await probe(n) < target) { low = n; break; }
      high = n; if (n === 0) return 0; step *= 2;
    }
    while (high - low > 1) { const mid = low + Math.floor((high - low) / 2); if (await probe(mid) >= target) high = mid; else low = mid; }
    return high;
  };
  const pair = async target => { const n = await firstAtOrAfter(target); if (n < 1) issue('EVM_BOUNDARY_INVALID'); await record('eth_getBlockByNumber', [hex(n - 1), false]); await record('eth_getBlockByNumber', [hex(n), false]); return n; };
  const first = await pair(r.at), end = r.until !== undefined ? await pair(r.until) : null;
  const calls = metricRequests(r, first, end);
  for (let i = 0; i < calls.length; i += 4) {
    const batch = calls.slice(i, i + 4), base = id; id += batch.length;
    const done = await Promise.all(batch.map(([method, params], k) => rpc(url, method, params, request, base + k).then(res => ({ request: { jsonrpc: '2.0', id: base + k, method, params }, response: res }))));
    exchanges.push(...done);
  }
  const body = JSON.stringify({ schema: 'flurbo.evm-capture.v1', rpc: url, chainId: r.chainId, exchanges });
  if (Buffer.byteLength(body) > 2_000_000) issue('SOURCE_TOO_LARGE');
  return { requestedUrl: url, finalUrl: url, fetchedAt: now(), status: 200, contentType: 'application/json', complete: true, bytes: Buffer.byteLength(body), body, sha256: digest(body) };
}

export function readerAccept(rule) {
  const r = rule.source.reader;
  if (rule.source.adapter === 'html-text.v1') return 'text/html';
  if (rule.source.adapter === 'stat-table.v1' && r.format === 'csv') return 'text/csv, text/plain;q=0.9';
  if (rule.source.adapter === 'stat-table.v1' && r.format === 'sdmx-json') return 'application/vnd.sdmx.data+json, application/json;q=0.9';
  return 'application/json';
}

// A record for the shared evaluator. Snapshot rules are timed by the capture itself; the initial vintage needs a
// publication time from the source, and the evaluator refuses one earlier than the market's observation window.
export function readGeneralRecord(rule, capture) {
  const adapter = rule.source.adapter;
  let read;
  if (adapter === 'json-api.v1') {
    if (!/^(?:application\/(?:json|[^;]+\+json)|text\/json)(?:;|$)/i.test(capture.contentType || '')) issue('CONTENT_TYPE_MISMATCH');
    read = jsonApi(capture.body, rule);
  } else if (adapter === 'stat-table.v1') read = statTable(capture.body, rule, capture.contentType);
  else if (adapter === 'html-text.v1') read = htmlText(capture.body, rule, capture.contentType);
  else if (adapter === 'evm-rpc.v1') read = evmRpc(capture.body, rule, capture);
  else issue('ADAPTER_UNSUPPORTED');
  const snapshot = rule.vintage === 'first-observed-snapshot', publishedAt = snapshot ? capture.fetchedAt : read.publishedAt;
  if (!snapshot && publishedAt === null) issue('RECORD_METADATA_INVALID');
  return { id: snapshot ? `${adapter}:${capture.sha256}` : `${adapter}:${rule.source.id}:${publishedAt}`, ...rule.observation, kind: 'initial',
    value: read.value, publishedAt, timestampMeaning: snapshot ? 'first-retained-capture-time' : 'source-publication-time' };
}
