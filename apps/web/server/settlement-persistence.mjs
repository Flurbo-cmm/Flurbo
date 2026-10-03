import { canonical, digest } from './settlement-rules.mjs';
import { verifySettlementPacket } from './settlement-evidence.mjs';
import { isIP } from 'node:net';

export const SETTLEMENT_PACKET_PATH = '/api/settlement/packets/';
export const MAX_SETTLEMENT_PACKET_BYTES = 16_000_000;
const MAX_CAPTURES = 50; // Each distinct body retains its first and most recent observation, at most 100 snapshots.
const hash = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const second = value => Number.isSafeInteger(value) && value >= 0;
const fail = message => { throw Error(message); };

export function settlementPublicOrigin(value) {
  let url;
  try { url = new URL(value); } catch { fail('Public evidence HTTPS origin required'); }
  if (url.origin !== value || url.protocol !== 'https:' || url.username || url.password || url.port
    || !url.hostname.includes('.') || isIP(url.hostname.replace(/^\[|\]$/g, ''))
    || /(?:^|\.)(?:localhost|local|internal|test|invalid|example)$/.test(url.hostname)) fail('Public evidence HTTPS origin required');
  return value;
}

// Exact script also supported by the isolated local rehearsal backend. Never expire captured evidence.
export const captureHistoryScript = `-- flurbo-settlement-captures-v1
local raw=redis.call('GET',KEYS[1]); local state=raw and cjson.decode(raw) or {schema='flurbo.settlement-captures.v1',entries={}}
if state.schema~='flurbo.settlement-captures.v1' then return redis.error_reply('Invalid capture history') end
if ARGV[1]=='attempt' then
  local attempt=cjson.decode(ARGV[2]); if state.attempt and state.attempt.at>attempt.at then return 0 end; state.attempt=attempt
elseif ARGV[1]=='capture' then
  local incoming=cjson.decode(ARGV[2]); local found=false
  for _,item in ipairs(state.entries) do
    if item.id==incoming.id then item.first=math.min(item.first,incoming.first); item.last=math.max(item.last,incoming.last); found=true; break end
  end
  if not found then if #state.entries>=50 then return redis.error_reply('Capture history capacity reached') end; table.insert(state.entries,incoming) end
else return redis.error_reply('Invalid capture operation') end
local body=cjson.encode(state); if string.len(body)>16000000 then return redis.error_reply('Capture history capacity reached') end
redis.call('SET',KEYS[1],body); return 1`;

function validateCapture(capture) {
  if (!capture || !second(capture.fetchedAt) || capture.complete !== true || capture.status !== 200
    || typeof capture.requestedUrl !== 'string' || capture.finalUrl !== capture.requestedUrl
    || typeof capture.contentType !== 'string' || typeof capture.body !== 'string'
    || !capture.body.length || Buffer.byteLength(capture.body) > 2_000_000 || capture.bytes !== Buffer.byteLength(capture.body)
    || !hash(capture.sha256) || digest(capture.body) !== capture.sha256) fail('Invalid complete source capture');
  return { ...capture, fetchedAt: 0 };
}
function history(raw) {
  if (raw === null) return { schema: 'flurbo.settlement-captures.v1', entries: [] };
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_SETTLEMENT_PACKET_BYTES) fail('Invalid capture history');
  const state = JSON.parse(raw);
  // Redis cjson encodes an empty Lua table as an object.
  if (state?.entries && !Array.isArray(state.entries) && !Object.keys(state.entries).length) state.entries = [];
  if (state?.schema !== 'flurbo.settlement-captures.v1' || !Array.isArray(state.entries) || state.entries.length > MAX_CAPTURES) fail('Invalid capture history');
  const ids = new Set();
  for (const item of state.entries) {
    if (!item || !second(item.first) || !second(item.last) || item.first > item.last || item.capture?.fetchedAt !== 0
      || digest(canonical(validateCapture(item.capture))) !== item.id || ids.has(item.id)) fail('Capture history integrity failed');
    ids.add(item.id);
  }
  if (state.attempt) validateAttempt(state.attempt);
  return state;
}
function validateAttempt(attempt) {
  if (!attempt || !second(attempt.at) || typeof attempt.ok !== 'boolean' || !Array.isArray(attempt.issues)
    || attempt.issues.length > 32 || attempt.issues.some(issue => typeof issue !== 'string' || !/^[A-Z0-9_]{1,96}$/.test(issue))
    || (attempt.ok && attempt.issues.length)) fail('Invalid capture attempt');
}

export function createSettlementStores({ command, origin = null, now = () => Math.floor(Date.now() / 1000) }) {
  if (typeof command !== 'function') fail('Durable settlement command required');
  if (origin !== null) settlementPublicOrigin(origin);
  const captureKey = ruleHash => { if (!hash(ruleHash)) fail('Invalid rule hash'); return `flurbo:settlement:v1:captures:${ruleHash}`; };
  const packetKey = packetHash => { if (!hash(packetHash)) fail('Invalid packet hash'); return `flurbo:settlement:v1:packet:${packetHash}`; };
  const decodePacket = (body, sha256) => {
    if (typeof body !== 'string' || Buffer.byteLength(body) > MAX_SETTLEMENT_PACKET_BYTES || digest(body) !== sha256) fail('Settlement packet unavailable or corrupt');
    const packet = JSON.parse(body);
    if (canonical(packet) !== body) fail('Settlement packet not canonical');
    verifySettlementPacket(packet, { packetHash: sha256, expectedRuleHash: packet.ruleHash });
    return packet;
  };
  const captureStore = {
    async list(ruleHash) {
      const state = history(await command('GET', captureKey(ruleHash)));
      return state.entries.flatMap(item => [item.first, ...(item.last === item.first ? [] : [item.last])].map(fetchedAt => ({ ...item.capture, fetchedAt })));
    },
    async put(ruleHash, capture) {
      const key = captureKey(ruleHash), content = validateCapture(capture);
      if (capture.fetchedAt > now()) fail('Capture time is in the future');
      const item = { id: digest(canonical(content)), first: capture.fetchedAt, last: capture.fetchedAt, capture: content };
      history(await command('GET', key));
      await command('EVAL', captureHistoryScript, 1, key, 'capture', canonical(item));
      const saved = history(await command('GET', key)).entries.find(entry => entry.id === item.id);
      if (!saved || saved.first > item.first || saved.last < item.last) fail('Capture persistence failed');
      return { sha256: capture.sha256, firstFetchedAt: saved.first, latestFetchedAt: saved.last };
    },
    async recordAttempt(ruleHash, attempt) {
      validateAttempt(attempt); if (attempt.at > now()) fail('Capture attempt is in the future');
      const key = captureKey(ruleHash); history(await command('GET', key));
      return await command('EVAL', captureHistoryScript, 1, key, 'attempt', canonical(attempt)) === 1;
    },
    async latestAttempt(ruleHash) { return history(await command('GET', captureKey(ruleHash))).attempt ?? null; },
  };
  const packetStore = {
    async put(packet, sha256) {
      if (!origin) fail('Public packet origin is not configured');
      const key = packetKey(sha256), body = canonical(packet);
      decodePacket(body, sha256);
      await command('SET', key, body, 'NX');
      decodePacket(await command('GET', key), sha256);
      return { sha256, uri: origin + SETTLEMENT_PACKET_PATH + sha256 };
    },
    async getByHash(sha256) { return decodePacket(await command('GET', packetKey(sha256)), sha256); },
    async get(uri) {
      if (!origin || typeof uri !== 'string' || !uri.startsWith(origin + SETTLEMENT_PACKET_PATH)) fail('Foreign evidence packet URI');
      return this.getByHash(uri.slice((origin + SETTLEMENT_PACKET_PATH).length));
    },
    async verifyPublic(uri, { request = fetch } = {}) {
      if (!origin || typeof uri !== 'string' || !uri.startsWith(origin + SETTLEMENT_PACKET_PATH)) fail('Foreign evidence packet URI');
      const sha256 = uri.slice((origin + SETTLEMENT_PACKET_PATH).length); packetKey(sha256);
      const controller = new AbortController();
      const response = await request(uri, { redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]), headers: { Accept: 'application/json' } });
      try {
        if (response.status !== 200 || !response.body || response.redirected || (response.url && response.url !== uri)
          || response.headers.has('content-range') || !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') || '')) fail('Public settlement packet unavailable');
        const declared = response.headers.get('content-length'), encoded = response.headers.get('content-encoding');
        if (declared !== null && (!/^[0-9]+$/.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > MAX_SETTLEMENT_PACKET_BYTES)) fail('Public packet length invalid');
        const chunks = []; let size = 0;
        for await (const chunk of response.body) { size += chunk.byteLength; if (size > MAX_SETTLEMENT_PACKET_BYTES) fail('Public packet too large'); chunks.push(chunk); }
        if (declared !== null && (!encoded || encoded.toLowerCase() === 'identity') && size !== Number(declared)) fail('Public packet length mismatch');
        const body = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
        const packet = decodePacket(body, sha256);
        if (body !== canonical(await this.get(uri))) fail('Public packet differs from durable copy');
        return packet;
      } catch (error) { controller.abort(); await response.body?.cancel().catch(() => {}); throw error; }
    },
  };
  return { captureStore, packetStore };
}

// Read-only handler for the application server or a separately hosted public evidence endpoint.
// Accept exact raw paths only: no decoded slashes, dot segments, query strings or filesystem paths.
export function settlementPacketHandler(packetStore) {
  return async (req, res) => {
    if (!req.url?.startsWith(SETTLEMENT_PACKET_PATH)) return false;
    const sha256 = req.url.slice(SETTLEMENT_PACKET_PATH.length);
    const headers = { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' };
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { ...headers, Allow: 'GET, HEAD' }); res.end(); return true; }
    if (!hash(sha256)) { res.writeHead(404, headers); res.end(); return true; }
    try {
      const packet = await packetStore.getByHash(sha256), body = canonical(packet);
      res.writeHead(200, { ...headers, 'Cache-Control': 'public, max-age=31536000, immutable', ETag: `"sha256-${sha256}"`, 'Content-Length': Buffer.byteLength(body) });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch { res.writeHead(404, headers); res.end(); }
    return true;
  };
}
