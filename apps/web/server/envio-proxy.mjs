// Read-only, bounded queries against the public Envio indexer. The browser never
// supplies GraphQL text, an upstream URL, or an admin credential.
const TRADES = `query GetTrades($pool: String!, $limit: Int!) {
  Trade(where: { pool: { _eq: $pool } }, order_by: { blockNumber: desc }, limit: $limit) {
    id side scope mask quantityAtoms amountAtoms blockNumber timestamp
  }
}`;

const POSITION = `query GetPosition($id: String!) {
  TraderPosition_by_pk(id: $id) {
    trader totalCostAtoms totalProceedsAtoms totalRedeemedAtoms netCashflowAtoms tradeCount
  }
}`;

const PORTFOLIO = `query GetPortfolioPositions($traders: [String!]!, $pools: [String!]!) {
  TraderPosition(where: { trader: { _in: $traders }, pool: { _in: $pools } }, limit: 200) {
    pool trader totalCostAtoms totalProceedsAtoms totalRedeemedAtoms netCashflowAtoms tradeCount
  }
}`;

const address = value => typeof value === 'string' && /^0x[0-9a-f]{40}$/i.test(value);
const reply = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

export async function envioProxy(req, res, endpoint, fetcher = fetch) {
  if (req.method !== 'POST') return reply(res, 405, { error: 'Method not allowed' });
  if (!endpoint) return reply(res, 503, { error: 'Indexer unavailable' });
  let url;
  try {
    url = new URL(endpoint);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash
      || !url.hostname.endsWith('.hyperindex.xyz') || !url.pathname.endsWith('/v1/graphql')) throw Error();
  } catch { return reply(res, 503, { error: 'Indexer unavailable' }); }

  let input;
  try {
    let raw = '';
    for await (const chunk of req) {
      raw += chunk.toString();
      if (raw.length > 2048) return reply(res, 413, { error: 'Request too large' });
    }
    input = JSON.parse(raw);
  } catch { return reply(res, 400, { error: 'Invalid indexer request' }); }

  let query, variables;
  if (input?.kind === 'trades' && Object.keys(input).every(key => ['kind', 'pool', 'limit'].includes(key))
    && address(input.pool) && Number.isInteger(input.limit)
    && input.limit >= 1 && input.limit <= 20) {
    query = TRADES;
    variables = { pool: input.pool.toLowerCase(), limit: input.limit };
  } else if (input?.kind === 'position' && Object.keys(input).every(key => ['kind', 'pool', 'trader'].includes(key))
    && address(input.pool) && address(input.trader)) {
    query = POSITION;
    variables = { id: `${input.trader.toLowerCase()}-${input.pool.toLowerCase()}` };
  } else if (input?.kind === 'portfolio' && Object.keys(input).every(key => ['kind', 'pools', 'traders'].includes(key))
    && Array.isArray(input.pools) && input.pools.length >= 1 && input.pools.length <= 25
    && Array.isArray(input.traders) && input.traders.length >= 1 && input.traders.length <= 8
    && input.pools.every(address) && input.traders.every(address)) {
    query = PORTFOLIO;
    variables = { pools: [...new Set(input.pools.map(value => value.toLowerCase()))],
      traders: [...new Set(input.traders.map(value => value.toLowerCase()))] };
  } else return reply(res, 400, { error: 'Invalid indexer request' });

  try {
    const upstream = await fetcher(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(8000)
    });
    if (!upstream.ok) return reply(res, 502, { error: 'Indexer unavailable' });
    const bytes = await upstream.arrayBuffer();
    if (bytes.byteLength > 1024 * 1024) return reply(res, 502, { error: 'Indexer response too large' });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(Buffer.from(bytes));
  } catch { return reply(res, 502, { error: 'Indexer unavailable' }); }
}
