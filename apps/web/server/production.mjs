import {installRpcCapacity} from './rpc-capacity.mjs';
import {routedCommand, supabaseKv} from './supabase-kv.mjs';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { localApi } from './local-api.mjs';
import { cookieValue } from './session.mjs';
import { isTestingOperator, testingPages } from './testing-access.mjs';
import { hostedConfig, readerProvider } from './network.mjs';
import {previewAccess} from './preview-access.mjs';
import {configureApplications} from './access-applications.mjs';
import { RedisSessionStore, redisCommand } from './redis-session.mjs';
import { runComparison } from './learning-comparison.mjs';
import { learningService, learningRpc, loadLearningModel } from './learning-pool.mjs';
import { pilotEvidence, pilotRpc } from './pilot.mjs';
import { configurePilot } from './pilot-config.mjs';
import { androidAssetLinks } from './native-association.mjs';
import { configurePracticeCollections } from './practice-collections.mjs';
import { loadSemanticConfig, semanticDiagnostics } from './semantic-validation.mjs';
import { createSettlementStores } from './settlement-persistence.mjs';
import { starterConfig, starterFunds } from './starter-funds.mjs';
import { fundingAlerts } from './funding-alerts.mjs';
import { envioProxy } from './envio-proxy.mjs';
import { oracleCatalog, oracleClients, oracleEvidence, oracleService } from './oracle-integration.mjs';
import { oracleRelayWorker } from './oracle-relay-worker.mjs';
import { oracleAnswerWorker } from './oracle-answer-worker.mjs';
import { hybridSettlementCatalog, hybridSettlementWorker } from './hybrid-settlement-worker.mjs';
import { hybridArbitrationWorker } from './hybrid-arbitration-worker.mjs';
import { hybridCourtKeeper } from './hybrid-court-keeper.mjs';
import { hybridOperatorAlerts, readPoolForAlerts, walletBalances } from './hybrid-operator-alerts.mjs';
import { emailConfig, resendDelivery } from './settlement-email.mjs';
import { hybridNoticePools } from './hybrid-notices.mjs';
import { hybridPoolIndexes, hybridPortfolioService } from './hybrid-portfolio.mjs';
import { hybridMarketService } from './hybrid-market-service.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const security = {
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin',
  'Strict-Transport-Security': 'max-age=31536000', 'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
};

export function productionServer(config, store, staticRoot = dist) {
  const api = localApi({ publicOrigin: config.origin, rpcUrl: config.rpcUrl, store, sharedLimits: config.sharedLimits !== false, getLearningReport: () => config.learningReport,
    applications:config.applications, previewAccess:config.previewAccess===undefined?previewAccess():config.previewAccess, testingOperatorAccount:config.testingOperatorAccount, testFaucet:config.testFaucet, learningPool: config.learningPool, learningOperatorAccount: config.learningOperatorAccount,
    learningDashboardUrl: config.learningDashboardUrl, pilot: config.pilot, practiceCollections:config.practiceCollections, evidence: config.pilotEvidence, evidenceOptions: config.evidenceOptions, challengeOptions:config.challengeOptions, settlementPackets:config.settlementPackets, starter:config.starter, funding:config.fundingAlerts, oracle:config.oracle, oracleEvidenceStore:config.oracleEvidence, hybridNotices:config.hybridNotices, hybrid:config.hybrid, hybridPortfolio:config.hybridPortfolio });
  config.metrics = api.metrics;
  config.notices = api.notices;
  return createServer({ requestTimeout: 30_000, headersTimeout: 10_000, maxHeaderSize: 16_384 }, async (req, res) => {
    for (const [key, value] of Object.entries(security)) res.setHeader(key, value);
    // Liveness only. This deliberately does not claim contracts or RPC are ready.
    if (req.url === '/healthz' && req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ service: 'flurbo', chain_state: 'not_checked', learning_comparison: config.learningReport ? 'ready' : config.learningStatus || 'unavailable', learning_pool: config.learningPool ? 'configured' : 'unavailable', learning_model: config.learningModelStatus || 'unavailable', pilot_pool: config.pilot ? 'configured' : 'disabled', pilot_address: config.pilot?.manifest.pool || null, pilot_rules_hash: config.pilot?.manifest.rulesHash || null, settlement_bot: config.settlementBot ? config.settlementBot.status() : 'disabled', oracle_answerer: config.oracleAnswerer ? config.oracleAnswerer.status() : 'disabled', oracle_relay: config.oracleRelay ? config.oracleRelay.status() : 'disabled', hybrid_settlement: config.hybridSettlement ? config.hybridSettlement.status() : 'disabled', hybrid_arbitration: config.hybridArbitration ? config.hybridArbitration.status() : 'disabled', hybrid_court: config.hybridCourt ? config.hybridCourt.status() : 'disabled', hybrid_alerts: config.hybridAlerts ? config.hybridAlerts.status() : 'disabled', practice_collections: config.practiceCollections ? { active: config.practiceCollections.catalog.active, configured: [...config.practiceCollections.services].map(([namespace, service]) => ({ namespace, pool: service.manifest.pool, rulesHash: service.manifest.rulesHash, closesAt: service.manifest.publication.draft.closesAt })) } : null })); return; }
    if (req.headers.host !== new URL(config.origin).host) { res.writeHead(421); res.end(`Use ${config.origin}`); return; }
    if (req.url === '/envio') { await envioProxy(req, res, config.envioGraphqlUrl); return; }
    if (req.url === '/.well-known/assetlinks.json' && ['GET', 'HEAD'].includes(req.method)) {
      const body = config.androidAssetLinks;
      res.writeHead(body ? 200 : 404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify(body || { error: 'Android association is not configured' })); return;
    }
    if(req.url==='/rehearsal-rules'&&req.method==='GET'){
      res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});
      res.end(JSON.stringify({schema:'flurbo-rehearsal.v1',notice:'Scripted testnet fixtures only. These records do not describe real-world events and must never settle the official release market.',
        fixtures:[{event:'A',result:'YES',exercise:'Unchallenged assertion'},{event:'B',result:'NO',exercise:'Intentionally propose YES, challenge with NO, two reviewers vote NO'},{event:'C',result:null,exercise:'No assertion; finalize VOID after its assertion deadline'},{event:'D',result:'YES',exercise:'Unchallenged assertion'}]}));return;
    }
    if (!req.url || req.url.length > 4096) { res.writeHead(414); res.end(); return; }
    await api(req, res, async () => {
      if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
      // Page-like paths that are not allowed get the public app shell with a 404
      // status, so visitors see Flurbo navigation. Assets keep a plain 404.
      const notFound = async (pathname) => {
        if (/\.[a-zA-Z0-9]+$/.test(pathname.split('/').pop() || '')) { res.writeHead(404); res.end('Not found'); return; }
        try {
          const shell = await readFile(resolve(staticRoot, 'index.html'));
          res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(req.method === 'HEAD' ? undefined : shell);
        } catch { if (!res.headersSent) res.writeHead(404); res.end('Not found'); }
      };
      try {
        const pathname = new URL(req.url, config.origin).pathname;
        const operatorPage = testingPages.has(pathname);
        if (operatorPage) {
          const session = await store.read(cookieValue(req.headers.cookie, 'flurbo_tools'), config.origin);
          res.setHeader('Cache-Control','no-store');
          if (!isTestingOperator(session, config.testingOperatorAccount)) { await notFound(pathname); return; }
        }
        // Serve agent deep links on direct visits too; API session and invite gates still protect data.
        const agentPage = /^\/agents(?:\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/.test(pathname);
        const page = agentPage || /^\/oracle(?:\/[a-z0-9-]{1,64})?$/.test(pathname) || /^\/markets\/oracle\/[a-z0-9-]{1,64}$/.test(pathname) || /^\/markets\/hybrid\/0x[0-9a-f]{40}\/(?:[0-9]|[12][0-9]|3[01])(?:\/thesis)?$/i.test(pathname) || /^\/markets\/(?:pilot|practice-[0-9a-f]{40})\/[0-3](?:\/thesis)?$/.test(pathname) || ['/', '/docs', '/markets', '/fund', '/access', '/login', '/signup', '/account', '/portfolio', '/history', '/events', '/evidence', '/metrics'].includes(pathname);
        const brandAsset=/^\/brand\/(?:flurbo-icon-512\.png|flurbo-profile-2026\.png|flurbo-logo\.svg|flurbo-social-(?:landscape|portrait|banner|banner-v2)\.png)$/.test(pathname);
        const publicationAsset=pathname==='/technical_litepaper.pdf'||pathname==='/hybrid-meta-evidence.json';
        if (!page && !brandAsset && !publicationAsset && !/^\/(?:assets\/[a-zA-Z0-9_.-]+|favicon(?:-contour)?\.svg|robots\.txt)$/.test(pathname)) { await notFound(pathname); return; }
        const file = resolve(staticRoot, page ? 'index.html' : pathname.slice(1));
        if (!(await stat(file)).isFile()) throw new Error('Not a file');
        const type = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json':'application/json', '.svg': 'image/svg+xml', '.png':'image/png', '.pdf':'application/pdf', '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain', '.wasm':'application/wasm', '.zkey':'application/octet-stream' }[extname(file)] || 'application/octet-stream';
        const cache=publicationAsset||pathname==='/robots.txt'?'public, max-age=3600':operatorPage || page ? 'no-store' : 'public, max-age=31536000, immutable';
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cache });
        res.end(req.method === 'HEAD' ? undefined : await readFile(file));
      } catch { if (!res.headersSent) res.writeHead(404); res.end('Not found'); }
    });
  });
}

async function main() {
  const config = hostedConfig();
  const companySite = config.origin === 'https://flurbopm.singu.online';
  config.envioGraphqlUrl = process.env.FLURBO_ENVIO_GRAPHQL_URL || null;
  config.applications = configureApplications();
  config.androidAssetLinks = config.origin === 'https://flurbo.singu.online' ? androidAssetLinks() : null;
  // With FLURBO_SUPABASE_KV=true, price history, the trade history and payout indexes and operator metrics live
  // in Supabase (migration 004) instead of Redis; every other key stays in Redis. Copy them first with
  // scripts/move-kv-to-supabase.mjs.
  const redis = redisCommand();
  const store = new RedisSessionStore(process.env.FLURBO_SUPABASE_KV === 'true' ? routedCommand(redis, supabaseKv()) : redis);
  await store.command('PING');
  // Rate windows (chain requests, page requests, agent runtime requests) count in this process by default:
  // Render runs one instance, and a shared Redis counter cost one command per request. Set
  // FLURBO_SHARED_LIMITS=true when running more than one instance so they share the budgets again.
  const sharedLimits = config.sharedLimits = process.env.FLURBO_SHARED_LIMITS === 'true';
  installRpcCapacity({command:sharedLimits?store.command:null});
    config.pilotEvidence = pilotEvidence(store.command, config.origin);
    const settlementStores = createSettlementStores({command:store.command,origin:config.origin});
    config.settlementPackets = settlementStores.packetStore;
  config.starter = starterFunds({ config: starterConfig(), command: store.command, rpcUrl: config.rpcUrl });
  if (companySite && config.starter && config.starter.address.toLowerCase() !== process.env.FLURBO_COMPANY_STARTER_ADDRESS?.toLowerCase())
    throw Error('Company starter wallet needs an explicit matching public address');
  // Low-balance email for the AUSD dispenser and the starter MON wallet, checked by the settlement bot.
  config.fundingAlerts = fundingAlerts({ rpcUrl: config.rpcUrl, command: store.command, dispenser: config.testFaucet,
    starter: config.starter ? { address: config.starter.address, amount: config.starter.amountWei } : null });
  config.pilot = companySite ? null : await configurePilot({rpcUrl:config.rpcUrl,command:store.command});
  if (companySite) {
    const catalog = oracleCatalog(JSON.parse(await readFile(resolve(root, 'config/oracle-markets.json'), 'utf8')));
    const hybrid = hybridSettlementCatalog(JSON.parse(await readFile(resolve(root, 'config/hybrid-markets.json'), 'utf8')));
    let hybridRelayTail = Promise.resolve();
    const hybridRelaySend = task => {
      const next = hybridRelayTail.then(task, task);
      hybridRelayTail = next.catch(() => {});
      return next;
    };
    const [source, market] = oracleClients(process.env.FLURBO_SEPOLIA_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com', config.rpcUrl);
    config.oracleEvidence = oracleEvidence(store.command, config.origin);
    const hybridIndexes = hybridPoolIndexes({ pools: hybrid.pools, market, command: store.command,
      fallbackRpc: new URL(config.rpcUrl).hostname === 'testnet-rpc.monad.xyz' ? null : pilotRpc('https://testnet-rpc.monad.xyz') });
    config.hybridNotices = hybridNoticePools({ pools: hybrid.pools, market, source, command: store.command, indexes: hybridIndexes });
    if (hybrid.pools.length) config.hybridPortfolio = hybridPortfolioService({ catalog: hybrid, market, indexes: hybridIndexes });
    if (hybrid.pools.length) config.hybrid = hybridMarketService({ catalog: hybrid,
      market, source, evidence: config.oracleEvidence, origin: config.origin, command: store.command });
    if (catalog.routes.some(route => route.evidenceOrigin !== config.origin)) throw Error('Oracle evidence origin must match this site');
    config.oracle = oracleService({ catalog, source, market, evidence: config.oracleEvidence });
    if (process.env.FLURBO_ORACLE_ANSWER_ENABLED === 'true' && catalog.routes.length) {
      config.oracleAnswerer = oracleAnswerWorker({ routes: catalog.routes, source,
        command: store.command, rpcUrl: process.env.FLURBO_SEPOLIA_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com',
        privateKey: process.env.FLURBO_ORACLE_ANSWER_PRIVATE_KEY,
        beaconUrl: process.env.FLURBO_SEPOLIA_BEACON_URL || null });
    }
    if (process.env.FLURBO_ORACLE_RELAY_ENABLED === 'true' && catalog.routes.length) {
      config.oracleRelay = oracleRelayWorker({ routes: catalog.routes, source, market,
        command: store.command, evidence: config.oracleEvidence, rpcUrl: config.rpcUrl,
        privateKey: process.env.FLURBO_ORACLE_RELAY_PRIVATE_KEY });
    }
    if (process.env.FLURBO_HYBRID_SETTLEMENT_ENABLED === 'true' && hybrid.pools.length) {
      config.hybridSettlement = hybridSettlementWorker({ pools: hybrid.pools, source, market,
        command: store.command, archive: config.pilotEvidence,
        captureStore: settlementStores.captureStore, packetStore: settlementStores.packetStore,
        oracleEvidence: config.oracleEvidence, origin: config.origin, marketRpcUrl: config.rpcUrl,
        proposerPrivateKey: process.env.FLURBO_HYBRID_PROPOSER_PRIVATE_KEY,
        relayPrivateKey: process.env.FLURBO_HYBRID_RELAY_PRIVATE_KEY, relaySend: hybridRelaySend,
        answererPrivateKey: process.env.FLURBO_HYBRID_ANSWER_PRIVATE_KEY || null,
        sourceRpcUrl: process.env.FLURBO_SEPOLIA_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com' });
    }
    if (process.env.FLURBO_HYBRID_ARBITRATION_ENABLED === 'true' && hybrid.pools.length) {
      const routes = hybrid.pools.flatMap(pool => pool.prepared.draft.events.map((event, eventIndex) =>
        event.route === 'mechanical' ? { id: `${pool.id}-${eventIndex}`, pool: pool.pool,
          resolver: pool.resolver, adapter: pool.adapter, manager: pool.manager,
          relay: pool.prepared.relay, rulesHash: pool.rulesHash,
          eventHash: pool.prepared.eventHashes[eventIndex], eventIndex,
          deploymentBlock: pool.deploymentBlock, question: event.question } : null).filter(Boolean));
      if (routes.length) config.hybridArbitration = hybridArbitrationWorker({ routes, source, market,
        command: store.command, evidence: config.oracleEvidence, marketRpcUrl: config.rpcUrl,
        sourceRpcUrl: process.env.FLURBO_SEPOLIA_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com',
        managerPrivateKey: process.env.FLURBO_HYBRID_CASE_MANAGER_PRIVATE_KEY,
        relayPrivateKey: process.env.FLURBO_HYBRID_RELAY_PRIVATE_KEY, relaySend: hybridRelaySend });
      const courtPools = hybrid.pools.filter(pool => pool.prepared.draft.events.some(event => event.route === 'reality'));
      if (courtPools.length) config.hybridCourt = hybridCourtKeeper({ pools: courtPools, source, command: store.command,
        evidence: config.oracleEvidence, rpcUrl: process.env.FLURBO_SEPOLIA_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com',
        privateKey: process.env.FLURBO_HYBRID_CASE_MANAGER_PRIVATE_KEY,
        maxDisputeFeeWei: BigInt(process.env.FLURBO_HYBRID_MAX_DISPUTE_FEE_WEI || '20000000000000000') });
    }
    if (process.env.FLURBO_HYBRID_ALERTS_ENABLED === 'true' && hybrid.pools.length) {
      try {
        const mail = emailConfig(process.env);
        config.hybridAlerts = hybridOperatorAlerts({ pools: hybrid.pools, command: store.command,
          readPool: record => readPoolForAlerts(record, market, source), deliver: resendDelivery(mail),
          from: mail.from, to: mail.to, origin: config.origin,
          workers: () => ({ hybrid_settlement: config.hybridSettlement?.status(),
            hybrid_arbitration: config.hybridArbitration?.status(), hybrid_court: config.hybridCourt?.status() }),
          balances: () => walletBalances(source, hybrid.pools) });
      } catch { console.error('Hybrid alerts disabled: set FLURBO_MONITOR_EMAIL_TO, FLURBO_MONITOR_EMAIL_FROM and FLURBO_MONITOR_RESEND_KEY'); }
    }
  }
  config.practiceCollections=await configurePracticeCollections({rpcUrl:config.rpcUrl,command:store.command});
  for(const service of config.practiceCollections.services.values())if(config.pilot&&(service.manifest.pool===config.pilot.manifest.pool||service.manifest.resolver===config.pilot.manifest.resolver))throw Error('Practice collections must be separate from the real pilot');
  // Invalid semantic configuration fails the deploy here instead of failing purchases later.
  const semantics = loadSemanticConfig();
  const semanticStatus = semanticDiagnostics(semantics, [['pilot', config.pilot], ...config.practiceCollections.services]
    .filter(([, service]) => service).map(([namespace, service]) => ({ namespace, manifest: service.manifest })));
  console.log(`Semantic validation ${semantics.mode} (revision ${semantics.revision.slice(0, 12)}): `
    + semanticStatus.markets.map(m => `${m.namespace}=${m.status}`).join(', '));
  for (const m of semanticStatus.markets) if (m.error) console.error(`Semantic rules for ${m.namespace} are misconfigured; new purchases there stop until fixed: ${m.error}`);
  if (semanticStatus.unusedRules.length) console.warn(`Semantic rules configured for unknown pools: ${semanticStatus.unusedRules.join(', ')}`);
  const comparison = new AbortController();
  config.learningStatus = 'starting';
  // Do not hold up account/trading access while a sleeping free-tier server warms.
  void runComparison({ signal: comparison.signal }).then(report => {
    config.learningReport = report;
    config.learningStatus = 'ready';
    console.log('Rust comparison ready: fixed synthetic suite; executable pool prices unchanged');
  }).catch(() => {
    config.learningStatus = 'unavailable';
    console.error('Rust comparison unavailable; comparison API disabled, existing trading service continues');
  });
  // Optional operator access is a Mera login identity, separate from the immutable
  // MetaMask updater. Never infer administrator access from a client-supplied wallet.
  const operatorAccount = process.env.FLURBO_LEARNING_OPERATOR_ACCOUNT?.toLowerCase();
  config.learningOperatorAccount = /^0x[0-9a-f]{40}$/.test(operatorAccount || '') && !/^0x0{40}$/.test(operatorAccount) ? operatorAccount : null;
  let learningModel = null;
  try {
    if (companySite) throw Error('Company site does not load the legacy learning pool');
    const manifest = JSON.parse(await readFile(resolve(root, 'config/learning-testnet.json'), 'utf8'));
    config.learningPool = learningService({ manifest, rpc: learningRpc(config.rpcUrl), modelReport: () => learningModel });
    config.learningModelStatus = 'starting';
    void loadLearningModel().then(report => { learningModel = report; config.learningModelStatus = 'ready'; }).catch(() => {
      config.learningModelStatus = 'unavailable';
      console.error('Learning fixture unavailable; proposal preparation disabled');
    });
  } catch { if (!companySite) console.error('Learning pool configuration unavailable; existing trading continues'); }
  let reader, learningReader;
  if (config.learningPool) {
    config.learningDashboardUrl = 'http://127.0.0.1:18768';
    learningReader = spawn(process.env.PYTHON || 'python3', ['scripts/serve_dashboard.py', '--manifest',
      'config/learning-testnet.json', '--learning-market', '--port', '18768',
      '--provider', readerProvider(process.env.FLURBO_ALCHEMY_TESTNET_RPC_URL)], { cwd: root, stdio: 'inherit', windowsHide: true });
    learningReader.on('error', () => console.error('Learning market reader could not start; requests will remain unavailable'));
    learningReader.on('exit', () => console.error('Learning market reader stopped; requests will remain unavailable'));
  }
  if (!companySite && process.env.FLURBO_MANIFEST_JSON) {
    const manifest = JSON.parse(process.env.FLURBO_MANIFEST_JSON);
    if (manifest.environment !== 'public_testnet' || manifest.status !== 'verified_snapshot' || manifest.chain_id !== 10143) throw new Error('Verified public Monad testnet manifest required');
    // The non-secret manifest is supplied through hosting configuration, never
    // copied from a developer's local fork or accepted from an HTTP request.
    const { writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const manifestPath = resolve(tmpdir(), 'flurbo-public-manifest.json');
    await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
    reader = spawn(process.env.PYTHON || 'python3', ['scripts/serve_dashboard.py', '--manifest', manifestPath,
      '--provider', readerProvider(process.env.FLURBO_ALCHEMY_TESTNET_RPC_URL)], { cwd: root, stdio: 'inherit', windowsHide: true });
    reader.on('error', () => { console.error('Public chain reader could not start'); process.exit(1); });
    reader.on('exit', () => { console.error('Public chain reader stopped'); process.exit(1); });
  }
  const server = productionServer(config, store);
  server.listen(config.port, '0.0.0.0', () => console.log('Flurbo server ready; public trading requires a verified deployment manifest'));
  config.oracleAnswerer?.start();
  config.oracleRelay?.start();
  config.hybridSettlement?.start();
  config.hybridArbitration?.start();
  config.hybridCourt?.start();
  config.hybridAlerts?.start();
  // Optional settlement monitor and resolution worker for hosts without a reliable free scheduler.
  // Disabled unless explicitly enabled; the separate GitHub Actions path is unchanged.
  if (process.env.FLURBO_SETTLEMENT_BOT === 'true') {
    const { settlementBot } = await import('./settlement-bot.mjs');
    // Operator metrics ride the same cycle: advance the trade scan, then send the daily summary when due.
    config.settlementBot = settlementBot({ env: process.env, metrics: config.metrics ? () => config.metrics.tick() : null,
      funds: config.fundingAlerts ? () => config.fundingAlerts.tick() : null, notices: config.notices ? async () => {
        const result = await config.notices.tick(), d = config.notices.diagnostics?.();
        return d && d.stages && !d.emailed ? `${result} (stages ${d.stages}, wallets ${d.wallets}, unlinked ${d.unlinked}, no verified email ${d.withoutEmail})` : result;
      } : null });
    config.settlementBot.start();
    console.log('Settlement bot enabled: monitor, worker and metrics every 2 minutes');
  }
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
    comparison.abort(); config.settlementBot?.stop(); config.oracleAnswerer?.stop(); config.oracleRelay?.stop();
    config.hybridSettlement?.stop(); config.hybridArbitration?.stop(); config.hybridCourt?.stop(); config.hybridAlerts?.stop();
    server.close(() => process.exit(0)); reader?.kill(); learningReader?.kill();
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(() => { console.error('Hosting startup failed. Check origin, network, Redis and public deployment configuration.'); process.exitCode = 1; });
