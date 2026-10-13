// Provider tokens sit in RPC URL paths (Alchemy /v2/<key>, QuickNode /<token>/), so any URL that reaches a
// public status or a log line keeps only its scheme and host.
const URL_PATTERN = /\b(?:https?|wss?):\/\/[^\s"'<>]+/gi;

export const redactUrls = text => String(text).replace(URL_PATTERN, match => {
  try { const url = new URL(match); return `${url.protocol}//${url.host}`; } catch { return '[url]'; }
});

export function publicStatus(value, depth = 0) {
  if (typeof value === 'string') return redactUrls(value).slice(0, 1000);
  if (value === null || typeof value !== 'object' || depth > 8) return value;
  if (Array.isArray(value)) return value.map(item => publicStatus(item, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, publicStatus(item, depth + 1)]));
}
