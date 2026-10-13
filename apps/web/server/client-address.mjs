import { isIP } from 'node:net';

// Where the hosting proxy puts the visitor's address. Rate limits use it as a best-effort client identity:
// x-forwarded-for takes the first entry, x-forwarded-for-last the entry the nearest proxy appended, and the
// cf-connecting-ip and true-client-ip headers are set by Cloudflare when it fronts the site.
export const CLIENT_ADDRESS_HEADERS = ['x-forwarded-for', 'x-forwarded-for-last', 'cf-connecting-ip', 'true-client-ip'];

function expand(v6) {
  const [head, tail = ''] = v6.split('::');
  const left = head ? head.split(':') : [], right = tail ? tail.split(':') : [];
  const groups = v6.includes('::') ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  return groups.map(g => g.toLowerCase().replace(/^0+(?=.)/, ''));
}

// IPv4 addresses as they are; IPv6 grouped by /64, which one subscriber usually controls in full.
export function normalizeAddress(value) {
  const address = String(value || '').trim().replace(/^\[|\]$/g, '').split('%')[0];
  const kind = isIP(address);
  if (kind === 4) return address;
  if (kind !== 6) return null;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (mapped && isIP(mapped[1]) === 4) return mapped[1];
  if (address.includes('.')) return null;
  return expand(address).slice(0, 4).join(':') + '::/64';
}

export function clientAddressReader(source = 'x-forwarded-for') {
  if (!CLIENT_ADDRESS_HEADERS.includes(source)) throw Error('Unsupported client address header');
  const header = source === 'x-forwarded-for-last' ? 'x-forwarded-for' : source;
  return req => {
    const raw = req.headers?.[header];
    const entries = (Array.isArray(raw) ? raw.join(',') : String(raw ?? '')).split(',').map(x => x.trim()).filter(Boolean);
    const chosen = source === 'x-forwarded-for-last' ? entries.at(-1) : entries[0];
    return normalizeAddress(chosen) ?? normalizeAddress(req.socket?.remoteAddress) ?? 'unknown';
  };
}
