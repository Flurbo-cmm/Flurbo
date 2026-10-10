const NAMES: Record<string, string> = {
  'json-api.v1': 'Public JSON API',
  'json-api.v2': 'Public JSON API',
  'stat-table.v1': 'Official statistics table',
  'html-text.v1': 'Official web page',
  'evm-rpc.v1': 'EVM chain RPC',
  'proof-http.v1': 'Credentialed source with TLS proof',
  'pdf-text.v1': 'Official PDF document',
  'xml-feed.v1': 'XML or RSS feed',
  'json-record.v1': 'JSON record',
  'bls-employment-html.v1': 'BLS release page',
  'fomc-statement-html.v1': 'FOMC statement page',
  'usgs-earthquake-count.v1': 'USGS catalogue',
};

export function readerName(adapter: string | null | undefined): string {
  if (!adapter) return 'Reality.eth';
  return Object.hasOwn(NAMES, adapter) ? NAMES[adapter] : adapter;
}

export function credentialedReader(adapter: string | null | undefined): boolean {
  return adapter === 'proof-http.v1';
}
