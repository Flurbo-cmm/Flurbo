import {requestLimits,CapacityError,expensivePath} from './request-limits.mjs';
import {rpcFetch} from './rpc-capacity.mjs';
import { SessionStore, cookieValue, LOGIN_MS, digest } from './session.mjs';
import { TESTNET, HOSTED_ORIGINS } from './network.mjs';
import { learningDeployment } from '../shared/learning-contracts.mjs';
import { evidenceAssistant } from './evidence-assistant.mjs';
import { priceHistory } from './price-history.mjs';
import { walletLinks } from './wallet-links.mjs';
import { isTestingOperator, DEFAULT_TESTING_OPERATOR } from './testing-access.mjs';
import {holderAuthorizer} from './holder-challenge.mjs';
import {validateClaim} from '../shared/claims.mjs';
import {validateThesisInput} from '../shared/thesis.mjs';
import {agentApi} from './agents/agent-api.mjs';
import {agentWalletKey} from './agents/agent-store.mjs';
import {agentRpc} from './agents/agent-market.mjs';
import {assessSemantics,activeSemanticConfig,semanticDiagnostics} from './semantic-validation.mjs';
import {ApplicationError} from './access-applications.mjs';
import {settlementPacketHandler,SETTLEMENT_PACKET_PATH} from './settlement-persistence.mjs';
import {userMetrics} from './user-metrics.mjs';
import {memberNotices,noticeDelivery} from './member-notices.mjs';
import {handleAlchemyWebhook, getAlchemyActivities} from './alchemy-webhook.mjs';
import { EVIDENCE_PATH } from './oracle-integration.mjs';
import { HYBRID_PORTFOLIO_INPUT_ERRORS } from './hybrid-portfolio.mjs';
import { MAX_PROOF_SUBMISSION_BYTES, PROOF_CAPTURE_PATH } from './proof-captures.mjs';

export function localApi({ hosts = ['localhost:18767', '127.0.0.1:18767'], store = new SessionStore(), sharedLimits = true,
  publicOrigin = null, rpcUrl = 'http://127.0.0.1:18545', dashboardUrl = 'http://127.0.0.1:18765', getLearningReport = () => null,
  applications = null, previewAccess = null, testingOperatorAccount = DEFAULT_TESTING_OPERATOR, testFaucet = null, learningPool = null, learningOperatorAccount = null, learningDashboardUrl = null, pilot: publishedPilot = null, practiceCollections = null, evidence = null, evidenceOptions = {}, challengeOptions = {}, settlementPackets = null, starter = null, funding = null, oracle = null, oracleEvidenceStore = null, hybridNotices = [], hybrid = null, hybridPortfolio = null, proofCaptures = null } = {}) {
  const hosted = publicOrigin !== null;
  // Agent wallets cannot also be linked for manual MetaMask trading; with Redis the two claims exclude each other atomically.
  const links = walletLinks({command:store.command,isReserved:wallet=>agents?agents.isAgentWallet(wallet):false,reservedKey:store.command?agentWalletKey:null});
  // Operator addresses from every configured deployment, plus FLURBO_AGENT_RESERVED_WALLETS, can never be agent wallets.
  const reservedWallets=new Set((process.env.FLURBO_AGENT_RESERVED_WALLETS||'').split(',').map(x=>x.trim().toLowerCase()).filter(x=>/^0x[0-9a-f]{40}$/.test(x)));
  for(const svc of [publishedPilot,...(practiceCollections?.services.values()||[])].filter(Boolean)){
    const m=svc.manifest;
    for(const a of [m.pool,m.resolver,m.publication?.creator,m.challengePolicy?.authority,...(m.publication?.reviewers||[]).map(r=>r.address)])if(typeof a==='string')reservedWallets.add(a.toLowerCase());
  }
  const previewAllows=previewAccess||applications?async account=>{
    const session={method:'passkey',address:account};
    if(isTestingOperator(session,testingOperatorAccount))return true;
    const legacy=previewAccess?await previewAccess.allows(session):false;
    return applications?applications.allows(account,legacy):legacy;
  }:null;
  const authorizeHolder=holderAuthorizer(challengeOptions);
  const priceArchives=new WeakMap();
  const oraclePriceArchives=new Map();
  const hybridPriceArchives=new Map();
  // Agents: account-isolated profiles, paper trading and user-approved proposals. Never a signer.
  const agents=(()=>{try{return agentApi({command:store.command||null,hosted,links,localCounters:!sharedLimits,rpc:agentRpc(rpcUrl,{hosted}),previewAllows,reservedWallets,
    serviceFor:namespace=>namespace==='pilot'?publishedPilot:practiceCollections?.services.get(namespace)||null});}catch{return null;}})();
  // Operator-only growth metrics. Needs durable storage; members never see these numbers.
  const listedPools=()=>[
    ...(publishedPilot?[{namespace:'pilot',label:(practiceCollections?.catalog?.collections||[]).find(c=>c.pool===publishedPilot.manifest.pool)?.label||'Release milestones',service:publishedPilot}]:[]),
    ...[...(practiceCollections?.services||[])].map(([namespace,service])=>({namespace,label:practiceCollections.catalog.collections.find(c=>c.namespace===namespace)?.label||namespace,service}))]
    .filter(p=>p.service.index);
  const oracleNoticePools=oracle?.noticePools?.(store.command||null)||[];
  const metrics=userMetrics({command:store.command||null,origin:publicOrigin||`http://${hosts[0]}`,links,applications,operatorAccount:testingOperatorAccount,funding,
    openAccess:!previewAllows,reservedWallets,rpcUrl,pools:listedPools});
  // Email notices to members about their own positions and settlement stages.
  const notices=memberNotices({command:store.command||null,pools:()=>[...listedPools(),...oracleNoticePools,...hybridNotices],applications,links,origin:publicOrigin||`http://${hosts[0]}`,
    send:applications?.noticeEmail?noticeDelivery(applications.noticeEmail):null});
  const page=(res,status,title,body)=>{res.writeHead(status,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} | flurbo</title></head><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 16px;color:#14271d;background:#f5f4ec;line-height:1.5"><h1 style="font-size:1.5rem">${title}</h1>${body}</body></html>`);};
  const assistant=publishedPilot&&store.command?evidenceAssistant({manifest:publishedPilot.manifest,command:store.command,...evidenceOptions}):null;
  if (hosted && (!HOSTED_ORIGINS.has(publicOrigin) || !rpcUrl.startsWith('https://'))) throw new Error('Invalid hosted API configuration');
  // Anonymous/public traffic never consumes authenticated account capacity. With sharedLimits off (a single
  // server), the rate windows count in memory instead of costing Redis commands on every request.
  const limits=requestLimits({command:sharedLimits?store.command:null});
  const publicPackets=settlementPackets?settlementPacketHandler(settlementPackets):null;
  const send = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(body)); };
  const cookie = (name, value, age) => `${name}=${value}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=${age}${hosted ? '; Secure' : ''}`;
  const toolsCookie = (session, sid) => cookie('flurbo_tools', isTestingOperator(session, testingOperatorAccount) ? sid : '', isTestingOperator(session, testingOperatorAccount) ? Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1000)) : 0).replace('Path=/api;', 'Path=/;');
  async function body(req) {
    if (req.headers['content-type'] !== 'application/json') throw new Error('JSON required');
    let text = '';
    for await (const chunk of req) { text += chunk; if (text.length > 24_000) throw new Error('Request too large'); }
    return JSON.parse(text);
  }
  const handler = async (req, res, next) => {
    if (!req.url?.startsWith('/api/')) return next();
    const host = req.headers.host;
    if (hosted ? host !== new URL(publicOrigin).host : !hosts.includes(host)) return send(res, 403, { error: 'Unsupported application host' });
    // Published immutable packets must be readable without a login, including by
    // counterparties following the evidence URI from outside the application.
    if(publicPackets&&req.url.startsWith(SETTLEMENT_PACKET_PATH)){
      try{limits.localTake('public-settlement-packets',60);await publicPackets(req,res);}
      catch(error){if(error instanceof CapacityError){res.setHeader('Retry-After',String(error.retryAfter));return send(res,429,{error:'Public evidence request limit reached.'});}return send(res,503,{error:'Public evidence unavailable.'});}
      return;
    }
    if (req.method === 'GET' && req.url?.startsWith(EVIDENCE_PATH)) {
      const hash = req.url.slice(EVIDENCE_PATH.length);
      try {
        limits.localTake('oracle-public-evidence', 120);
        if (!oracleEvidenceStore) throw Error('Evidence unavailable');
        const value = await oracleEvidenceStore.get(hash);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
        res.end(value);
      } catch { send(res, 404, { error: 'Evidence unavailable' }); }
      return;
    }
    if (req.method === 'GET' && /^\/api\/hybrid\/rules\/0x[0-9a-f]{64}$/.test(req.url || '')) {
      try {
        limits.localTake('hybrid-public-rules', 120);
        if (!hybrid) throw Error('Rule unavailable');
        const value = hybrid.ruleFor(req.url.slice('/api/hybrid/rules/'.length));
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
        res.end(value);
      } catch { send(res, 404, { error: 'Rule unavailable' }); }
      return;
    }
    if (req.url === PROOF_CAPTURE_PATH) {
      if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
      if (!proofCaptures) return send(res, 404, { error: 'Proof submission unavailable' });
      try { limits.localTake('proof-capture-submit', 30); } catch { return send(res, 429, { error: 'Too many requests' }); }
      let text = '';
      req.setEncoding('utf8');
      for await (const chunk of req) {
        text += chunk;
        if (text.length > MAX_PROOF_SUBMISSION_BYTES) return send(res, 413, { error: 'Payload too large' });
      }
      const result = await proofCaptures.submit({ authorization: req.headers.authorization || '', body: text });
      return send(res, result.status, result.body);
    }
    if (req.url === '/api/alchemy/webhook') {
      if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
      let text = '';
      for await (const chunk of req) {
        text += chunk;
        if (text.length > 500_000) return send(res, 413, { error: 'Payload too large' });
      }
      const signature = req.headers['x-alchemy-signature'] || '';
      const result = await handleAlchemyWebhook({
        rawBody: text,
        signature,
        signingKey: process.env.FLURBO_ALCHEMY_WEBHOOK_SIGNING_KEY || ''
      });
      return send(res, result.status, result.body);
    }
    // Headless agent runtimes authenticate with a bearer credential only. Cookies are never read on these
    // routes, so the browser same-origin rules below do not apply; browsers are refused instead.
    if (req.url.startsWith('/api/agent-runtime/')) {
      try {
        limits.localTake('runtime-ingress:'+digest(req.headers.authorization||'anonymous'),180);
        limits.localTake('runtime-ingress',3600);
        const url = new URL(req.url, 'http://runtime.invalid');
        if (url.search) return send(res, 400, { code:'INVALID_INPUT', error:'Query parameters are not accepted. Send credentials only in the Authorization header.' });
        if (!agents) return send(res, 503, { code:'UNAVAILABLE', error:'Agents are unavailable on this server.' });
        if (!['GET','POST'].includes(req.method)) return send(res, 405, { code:'INVALID_INPUT', error:'Method not allowed.' });
        let text = '';
        if (req.method === 'POST') {
          if (req.headers['content-type'] !== 'application/json') return send(res, 400, { code:'INVALID_INPUT', error:'JSON required.' });
          for await (const chunk of req) { text += chunk; if (text.length > 64_000) return send(res, 413, { code:'INVALID_INPUT', error:'Request too large.' }); }
        }
        const result = await agents.runtime({ method:req.method, path:url.pathname, headers:req.headers, body:text, hosted });
        if (result.retryAfter) res.setHeader('Retry-After', String(result.retryAfter));
        return send(res, result.status, result.body);
      } catch(e) { if(e instanceof CapacityError){res.setHeader('Retry-After',String(e.retryAfter));return send(res,429,{code:e.code,error:e.message,retryable:true});} return send(res, 503, { code:'UNAVAILABLE', error:'The agent service is temporarily unavailable.', retryable:true }); }
    }
    const unsubscribe=req.url.match(/^\/api\/notifications\/unsubscribe\/([0-9a-zA-Zx.]{1,200})$/);
    if(unsubscribe){
      try{limits.localTake('notice-unsubscribe',120);}catch{return page(res,429,'Try again shortly','<p>Too many requests. Try again in a minute.</p>');}
      if(!notices)return page(res,503,'Unavailable','<p>Notices are not available right now.</p>');
      if(req.method==='GET')return page(res,200,'Stop Flurbo emails?',`<p>Stop all Flurbo notices about payouts, proposed answers, source windows and closing markets. You can turn them back on from Your account.</p><form method="post"><button type="submit" style="font:inherit;padding:10px 18px;border-radius:8px;border:0;background:#14271d;color:#f5f4ec;cursor:pointer">Stop all notices</button></form>`);
      if(req.method!=='POST')return page(res,405,'Not allowed','<p>Use the link in the email.</p>');
      for await(const chunk of req){if(chunk.length>2048)break;}
      const account=await notices.unsubscribe(unsubscribe[1]).catch(()=>null);
      return account?page(res,200,'You will not get Flurbo notices','<p>Done. You can turn notices back on from Your account at any time.</p>'):page(res,400,'Link not valid','<p>This unsubscribe link is not valid. Turn notices off from Your account instead.</p>');
    }
    const origin = publicOrigin || `http://${host}`;
    if ((req.headers.origin && req.headers.origin !== origin) || (req.method !== 'GET' && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site') return send(res, 403, { error: 'Same-origin request required' });
    const url = new URL(req.url, origin), sid = cookieValue(req.headers.cookie, 'flurbo_session');
    let loginPromise;
    const getLogin=()=>loginPromise??=store.read(sid,origin);
    try {
      if (hosted) {
        const publicRead=req.method==='GET'&&url.pathname==='/api/preview';
        limits.localTake('browser-ingress:'+(publicRead?'public:':'app:')+digest(sid||'anonymous'),600);
        if(publicRead)limits.localTake('public-preview',600);
        else {
          const authenticated=await getLogin();
          if(authenticated?.method==='passkey'){
            await limits.take('browser-account:'+authenticated.address.toLowerCase(),240);
            if(expensivePath(url.pathname))await limits.take('browser-expensive:'+authenticated.address.toLowerCase(),90);
            await limits.take('browser-authenticated-service',1200);
          } else {
            limits.localTake('anonymous',300);
            await limits.take('browser-anonymous',300);
          }
        }
      }
      if (req.method === 'GET' && url.pathname === '/api/preview') return send(res,200,{inviteOnly:!!previewAllows,applicationUrl:applications?null:previewAccess?.applicationUrl||null,...(applications?{nativeApplications:true}:{})});
      if (url.pathname === '/api/semantic-status') {
        const login = await getLogin();
        if (!login || login.method !== 'passkey') return send(res, 401, {error:'Sign in first.'});
        if (!isTestingOperator(login, testingOperatorAccount)) return send(res, 403, {error:'Operator access only.'});
        if (req.method !== 'GET' || url.search) return send(res, 400, {error:'Semantic status accepts a GET without parameters'});
        const services = [['pilot', publishedPilot], ...(practiceCollections ? [...practiceCollections.services] : [])]
          .filter(([, service]) => service).map(([namespace, service]) => ({ namespace, manifest: service.manifest }));
        try { return send(res, 200, semanticDiagnostics(activeSemanticConfig(), services)); }
        catch { return send(res, 503, {code:'SEMANTICS_UNAVAILABLE', error:'Semantic configuration could not be loaded.'}); }
      }
      if (url.pathname === '/api/admin/metrics' || url.pathname === '/api/admin/metrics/sync') {
        const login = await getLogin();
        if (!login || login.method !== 'passkey') return send(res, 401, {error:'Sign in first.'});
        if (!isTestingOperator(login, testingOperatorAccount)) return send(res, 403, {error:'Operator access only.'});
        if (url.search) return send(res, 400, {error:'Metrics accept no query parameters.'});
        if (!metrics) return send(res, 503, {error:'Metrics need durable storage.'});
        if (url.pathname === '/api/admin/metrics') {
          if (req.method !== 'GET') return send(res, 405, {error:'Method not allowed.'});
          try { return send(res, 200, await metrics.report()); } catch { return send(res, 503, {error:'Metrics could not be loaded. Try again shortly.'}); }
        }
        if (req.method !== 'POST') return send(res, 405, {error:'Method not allowed.'});
        await limits.take('admin-metrics-sync:' + login.address.toLowerCase(), 4);
        try { return send(res, 200, {sync: await metrics.sync({budgetMs:18_000,maxSteps:6})}); } catch { return send(res, 503, {error:'Trade data could not be scanned right now.'}); }
      }
      if (url.pathname === '/api/account/access' && req.method === 'GET') {
        const login = await getLogin();
        if (!login || login.method !== 'passkey') return send(res, 401, {error:'Sign in first.'});
        res.setHeader('Set-Cookie', toolsCookie(login, sid));
        return send(res, 200, {testingTools:isTestingOperator(login, testingOperatorAccount),approved:!previewAllows||await previewAllows(login.address),applicationUrl:applications?null:previewAccess?.applicationUrl||null,...(applications?{nativeApplications:true}:{})});
      }
      if(url.pathname==='/api/account/notifications'){
        const login=await getLogin();
        if(!login||login.method!=='passkey')return send(res,401,{error:'Sign in first.'});
        if(url.search)return send(res,400,{error:'Unexpected request.'});
        if(!notices)return send(res,503,{error:'Notices are unavailable.'});
        let email=null;
        try{const status=applications?await applications.handle({action:'status',account:login.address}):null;const a=status?.application;email=a?.verified&&a.state==='approved'?a.email:null;}catch{}
        const base={enabled:process.env.FLURBO_NOTIFY_ENABLED==='true',email};
        if(req.method==='GET')return send(res,200,{...base,preferences:await notices.preferences(login.address)});
        if(req.method!=='POST')return send(res,405,{error:'Method not allowed.'});
        try{return send(res,200,{...base,preferences:await notices.setPreferences(login.address,await body(req))});}
        catch(e){return send(res,e.status||503,{error:e.status?e.message:'Your choices could not be saved. Try again.'});}
      }
      if(url.pathname==='/api/account/application'||url.pathname.startsWith('/api/account/application/')){
        const login=await getLogin();
        if(!login||login.method!=='passkey')return send(res,401,{error:'Sign in first.'});
        if(!applications)return send(res,503,{error:'Applications are not open yet.'});
        const action=url.pathname==='/api/account/application'?'status':url.pathname.slice('/api/account/application/'.length);
        if(url.search||!((action==='status'&&req.method==='GET')||(action!=='status'&&req.method==='POST')))return send(res,405,{error:'Method unavailable.'});
        if(action.startsWith('admin/')&&!isTestingOperator(login,testingOperatorAccount))return send(res,403,{error:'Operator access only.'});
        const budget=async lane=>{
          await limits.take('applications:'+lane+':account:'+login.address.toLowerCase(),lane==='email'?3:20);
          await limits.take('applications:'+lane+':service',lane==='email'?10:120);
        };
        await budget('request');
        const input=req.method==='POST'?await body(req):{};
        return send(res,200,await applications.handle({action,account:login.address,input,operator:isTestingOperator(login,testingOperatorAccount),budget}));
      }
      // Guard every app data/action route, including legacy namespaces and RPC.
      // Published evidence stays readable by counterparties during settlement.
      const publicEvidence=req.method==='GET'&&!url.search&&/^\/api\/(pilot|practice-[0-9a-f]{40})\/evidence\/0x[0-9a-f]{64}$/.test(url.pathname);
      if(previewAllows&&!url.pathname.startsWith('/api/auth/')&&!publicEvidence){
        const login=await getLogin();
        if(!login||login.method!=='passkey')return send(res,401,{error:'Sign in with your Flurbo passkey.'});
        if(!await previewAllows(login.address))return send(res,403,{code:'INVITE_REQUIRED',error:'Testnet access has not been approved for this Mera account.'});
      }
      // Agent routes sit behind the same session and invite checks as every application route.
      if(url.pathname==='/api/agents'||url.pathname.startsWith('/api/agents/')){
        const login=await getLogin();
        if(!login||login.method!=='passkey')return send(res,401,{error:'Sign in with your Flurbo passkey.'});
        if(!agents)return send(res,503,{error:'Agents are unavailable on this server.'});
        if(url.search||!['GET','POST'].includes(req.method))return send(res,400,{error:'Unexpected agent request.'});
        const result=await agents.handle({method:req.method,path:url.pathname,input:req.method==='POST'?await body(req):undefined,login,origin,sessionDigest:digest(sid||'')});
        return send(res,result.status,result.body);
      }
      if (req.method === 'GET' && url.pathname === '/api/network') return send(res, 200, hosted ? {...TESTNET, faucet:testFaucet || TESTNET.faucet, flurboFaucet:!!testFaucet, starterMon:starter?.amountMon ?? null} : { environment: 'local_fork', chain_id: 10143 });
      if (req.method === 'GET' && url.pathname === '/api/alchemy/activity') return send(res, 200, getAlchemyActivities());
      if(url.pathname==='/api/market-directory'&&req.method==='GET'&&!url.search){
        const login=await getLogin();
        if(!login||login.method!=='passkey')return send(res,401,{error:'Sign in with your Flurbo passkey.'});
        const entries=[...(practiceCollections?.catalog?.collections||[])];
        if(publishedPilot&&!entries.some(row=>row.pool===publishedPilot.manifest.pool))entries.push({namespace:'pilot',label:'Release milestones',pool:publishedPilot.manifest.pool,closesAt:publishedPilot.manifest.publication.draft.closesAt});
        const oracleMarkets=oracle&&(!previewAllows||await previewAllows(login.address))?oracle.list():[];
        const hybridMarkets=hybrid&&(!previewAllows||await previewAllows(login.address))?hybrid.list():[];
        return send(res,200,{schema:'flurbo.market-directory.v1',markets:entries,oracleMarkets,hybridMarkets});
      }
      if (url.pathname === '/api/evidence-beta' || url.pathname.startsWith('/api/learning/')) {
        const login = await getLogin();
        if (!login || login.method !== 'passkey') return send(res, 401, {error:'Sign in first.'});
        if (!isTestingOperator(login, testingOperatorAccount)) return send(res, 403, {error:'Testing tools are restricted to the operator.'});
      }
      if(url.pathname==='/api/account/portfolio-sources'){
        const login=await getLogin();
        if(!login||login.method!=='passkey')return send(res,401,{error:'Sign in with your Flurbo passkey.'});
        if(req.method!=='GET'||url.search)return send(res,400,{error:'Unexpected portfolio request.'});
        if(hosted&&!store.command||!agents)return send(res,503,{error:'Account portfolio sources are unavailable.'});
        const manual=await links.list(login.address,origin);
        if(metrics)void metrics.recordExistingLinks(login.address,manual.wallets).catch(()=>{});
        const agent=await agents.portfolio(login.address,origin);
        return send(res,200,{account:manual.account,wallets:manual.wallets,agentWallets:agent.wallets,agentExecutions:agent.executions});
      }
      // One-time starter MON for an approved account's own linked wallet (see starter-funds.mjs).
      if(url.pathname==='/api/fund/starter'){
        const login=await getLogin();
        if(!login||login.method!=='passkey')return send(res,401,{error:'Sign in with your Flurbo passkey.'});
        if(url.search)return send(res,400,{error:'Unexpected request.'});
        if(req.method==='GET'){
          if(!starter)return send(res,200,{status:'disabled'});
          try{return send(res,200,await starter.status(login.address));}catch{return send(res,503,{error:'Free test MON status is unavailable.'});}
        }
        if(req.method!=='POST')return send(res,405,{error:'Method not allowed.'});
        if(!starter)return send(res,503,{error:'Free test MON is not available. Use the Monad faucet.'});
        const input=await body(req);
        if(Object.keys(input).join(',')!=='wallet'||typeof input.wallet!=='string')return send(res,400,{error:'Choose your linked wallet.'});
        const {wallets}=await links.list(login.address,origin);
        if(!wallets.some(w=>w.toLowerCase()===input.wallet.toLowerCase()))return send(res,403,{error:'Link this wallet to your account first.'});
        try{return send(res,200,await starter.send(login.address,input.wallet));}
        catch(e){return send(res,e.status||503,{code:e.code||'UNAVAILABLE',error:e.status?e.message:'Free test MON could not be sent right now. Use the Monad faucet.'});}
      }
      if (url.pathname.startsWith('/api/account/wallets')) {
        const login=await getLogin();
        if(!login||login.method!=='passkey')return send(res,401,{error:'Sign in with your Flurbo passkey.'});
        if(hosted&&!store.command)return send(res,503,{error:'Account wallet storage is unavailable.'});
        if(url.search)return send(res,400,{error:'Unexpected wallet query.'});
        if(req.method==='GET'&&url.pathname==='/api/account/wallets'){
          const listed=await links.list(login.address,origin);
          if(metrics)void metrics.recordExistingLinks(login.address,listed.wallets).catch(()=>{});
          return send(res,200,listed);
        }
        if(req.method!=='POST')return send(res,405,{error:'Method not allowed.'});
        const input=await body(req);
        try {
          if(url.pathname==='/api/account/wallets/challenge'&&Object.keys(input).join(',')==='wallet')return send(res,200,await links.challenge(login.address,input.wallet,origin,sid));
          if(url.pathname==='/api/account/wallets/verify'&&Object.keys(input).sort().join(',')==='id,signature'&&typeof input.id==='string'&&typeof input.signature==='string'){
            const before=starter||metrics?(await links.list(login.address,origin)).wallets:[];
            const linked=await links.verify(login.address,input.id,input.signature,origin,sid);
            // A newly linked wallet gets the one-time free test MON in the background; linking never waits on it.
            const added=(starter||metrics)&&linked.wallets.find(w=>!before.includes(w));
            if(added&&metrics)void metrics.recordLink(login.address,added).catch(()=>{});
            if(added&&starter)void starter.send(login.address,added).catch(()=>{});
            return send(res,200,linked);
          }
        } catch(e) {
          const safe=/^(Choose a MetaMask|Too many linking|Wallet proof rejected|This MetaMask wallet|This account has reached)/.test(e.message);
          return send(res,safe?400:503,{error:safe?e.message:'Account wallet storage is unavailable. Retry linking shortly.'});
        }
        return send(res,400,{error:'Invalid wallet linking request.'});
      }
      if(url.pathname==='/api/evidence-beta'){
        const login=await getLogin();
        if(!login||login.method!=='passkey')return send(res,401,{error:'Sign in with your Flurbo passkey'});
        if(!assistant)return send(res,503,{error:'Evidence beta needs the configured real-event pilot and durable storage'});
        const env=evidenceOptions.env||process.env;
        const operator=!!env.FLURBO_EVIDENCE_OPERATOR&&login.address.toLowerCase()===env.FLURBO_EVIDENCE_OPERATOR.toLowerCase();
        if(req.method==='GET')return send(res,200,{schema:'flurbo.evidence-beta.v1',operator,
          model:env.FLURBO_EVIDENCE_MODEL||null,aiConfigured:env.FLURBO_EVIDENCE_FREE_TIER_CONFIRMED==='true'&&!!env.FLURBO_EVIDENCE_GEMINI_KEY,
          events:publishedPilot.manifest.publication.draft.events.map(e=>({id:e.id,question:e.question}))});
        if(req.method!=='POST')return send(res,405,{error:'Method not allowed'});
        if(!operator)return send(res,403,{error:'Only the configured testnet operator may request source and model reads'});
        const input=await body(req);
        if(Object.keys(input).sort().join(',')!=='eventId,useAI'||typeof input.eventId!=='string'||typeof input.useAI!=='boolean')return send(res,400,{error:'Choose an event and whether to request AI assistance'});
        return send(res,200,await assistant.review(input.eventId,input.useAI));
      }
      if (url.pathname === '/api/oracle/markets' || /^\/api\/oracle\/[a-z0-9-]{1,64}(?:\/(?:action|evidence|market|price-history))?$/.test(url.pathname)) {
        const login = await getLogin();
        if (!login || login.method !== 'passkey') return send(res, 401, { error: 'Sign in first.' });
        if (previewAllows && !await previewAllows(login.address)) return send(res, 403, { error: 'Account approval required.' });
        if (!oracle) return send(res, 503, { error: 'Oracle markets are unavailable.' });
        try {
          if (url.pathname === '/api/oracle/markets') {
            if (req.method !== 'GET' || url.search) return send(res, 405, { error: 'GET without parameters required.' });
            return send(res, 200, { schema: 'flurbo.oracle-directory.v1', markets: oracle.list() });
          }
          const parts = url.pathname.split('/'), id = parts[3], op = parts[4] || '';
          if (op === 'market' && req.method === 'GET' && !url.search)
            return send(res, 200, await oracle.marketSummary(id));
          if (op === 'price-history' && req.method === 'GET' && !url.search) {
            if (!store.command) return send(res, 503, { error: 'Price history storage is unavailable.' });
            if (!oraclePriceArchives.has(id)) {
              const route = oracle.routeFor(id);
              const manifest = { chainId: 10143, pool: route.pool, rulesHash: route.eventHash,
                publication: { draft: { events: [{}] } } };
              oraclePriceArchives.set(id, priceHistory({ command: store.command, maxQuoteAtoms: 1_000_000_000_000n,
                service: { manifest, async markets() {
                  const value = await oracle.marketSummary(id);
                  return { manifest, open: value.funded && !value.resolved && value.marketNow < route.publication.closesAt,
                    snapshot: { timestamp: value.marketNow, blockNumber: value.blockNumber, blockHash: value.blockHash },
                    prices: [{ event: 0, yes: value.prices.yes, no: value.prices.no }] };
                } } }));
            }
            return send(res, 200, await oraclePriceArchives.get(id).read());
          }
          if (op === '' && req.method === 'GET') {
            const wallet = url.searchParams.get('wallet');
            if ([...url.searchParams.keys()].some(key => key !== 'wallet')) return send(res, 400, { error: 'Unexpected parameter.' });
            return send(res, 200, await oracle.snapshot(id, wallet));
          }
          if (url.search || req.method !== 'POST') return send(res, 405, { error: 'POST without parameters required.' });
          const input = await body(req);
          if (op === 'evidence') {
            if (!oracleEvidenceStore) return send(res, 503, { error: 'Evidence storage unavailable.' });
            const route = oracle.routeFor(id);
            const saved = await oracleEvidenceStore.put(route, login.address, input);
            return send(res, 200, saved);
          }
          if (op === 'action') {
            const plan = await oracle.prepare(id, input.action, input.input || {}, input.owner);
            return send(res, 200, plan);
          }
          return send(res, 404, { error: 'Oracle action unavailable.' });
        } catch (error) {
          return send(res, 400, { error: error instanceof Error && /^(Invalid |Reality |Oracle |Duplicate |Enter |Select |Bond |Arbitration |Evidence |Appeal |No |Trading |Shares |Fund |Approval |Unsupported |Insufficient |Kleros |Outside |New pool |RPC chain)/.test(error.message)
            ? error.message : 'Oracle request unavailable. Refresh and retry.' });
        }
      }
      if (/^\/api\/hybrid\/pool\/0x[0-9a-f]{40}\/(?:account|positions|history|collected-payouts)$/i.test(url.pathname)) {
        const login = await getLogin();
        if (!login || login.method !== 'passkey') return send(res, 401, { error: 'Sign in first.' });
        if (previewAllows && !await previewAllows(login.address)) return send(res, 403, { error: 'Account approval required.' });
        if (!hybridPortfolio) return send(res, 503, { error: 'Hybrid markets are unavailable.' });
        if (url.search) return send(res, 400, { error: 'Unexpected parameter.' });
        const [, , , , pool, op] = url.pathname.split('/'), method = op === 'account' ? 'GET' : 'POST';
        if (req.method !== method) return send(res, 405, { error: `${method} without parameters required.` });
        const input = method === 'POST' ? await body(req) : null;
        if (op === 'history' || op === 'collected-payouts') {
          if (!input || typeof input !== 'object' || Object.keys(input).length) return send(res, 400, { error: 'Unexpected input.' });
          try { return send(res, 200, op === 'history' ? await hybridPortfolio.history(pool) : await hybridPortfolio.payouts(pool)); }
          catch (error) {
            if (HYBRID_PORTFOLIO_INPUT_ERRORS.has(error?.message)) return send(res, 400, { error: error.message });
            console.warn(JSON.stringify({ status: op === 'history' ? 'hybrid_history_failed' : 'hybrid_payout_read_failed', pool: pool.toLowerCase() }));
            return send(res, 503, op === 'history'
              ? { error: 'Trade history is temporarily unavailable. Your on-chain holdings are loaded separately. Retry shortly.' }
              : { code: error?.code === 'PAYOUT_ARCHIVE_UNAVAILABLE' ? 'PAYOUT_ARCHIVE_UNAVAILABLE' : 'PAYOUT_READ_FAILED',
                error: 'Collected payouts could not be checked. Your current holdings are separate.' });
          }
        }
        try {
          return send(res, 200, op === 'account' ? await hybridPortfolio.account(pool)
            : await hybridPortfolio.positions(pool, input?.owner, input?.claims));
        } catch (error) {
          return HYBRID_PORTFOLIO_INPUT_ERRORS.has(error?.message) ? send(res, 400, { error: error.message })
            : send(res, 503, { error: 'Hybrid holdings are temporarily unavailable. Refresh and retry.' });
        }
      }
      if (/^\/api\/hybrid\/0x[0-9a-f]{40}-(?:[0-9]|[12][0-9]|3[01])(?:\/(?:market|action|analysis|evidence|price-history))?$/i.test(url.pathname)) {
        const login = await getLogin();
        if (!login || login.method !== 'passkey') return send(res, 401, { error: 'Sign in first.' });
        if (previewAllows && !await previewAllows(login.address)) return send(res, 403, { error: 'Account approval required.' });
        if (!hybrid) return send(res, 503, { error: 'Hybrid markets are unavailable.' });
        const parts = url.pathname.split('/'), id = parts[3], op = parts[4] || '';
        try {
          if (op === 'market' && req.method === 'GET' && !url.search)
            return send(res, 200, await hybrid.marketSummary(id));
          if (op === 'price-history' && req.method === 'GET' && !url.search) {
            if (!store.command) return send(res, 503, { error: 'Price history storage is unavailable.' });
            if (!hybridPriceArchives.has(id)) {
              const route = hybrid.routeFor(id);
              const manifest = { chainId: 10143, pool: route.pool, rulesHash: route.eventHash,
                publication: { draft: { events: [{}] } } };
              hybridPriceArchives.set(id, priceHistory({ command: store.command,
                maxQuoteAtoms: 1_000_000_000_000n,
                service: { manifest, async markets() {
                  const value = await hybrid.marketSummary(id);
                  return { manifest, open: value.funded && !value.resolved
                    && value.marketNow < route.record.prepared.draft.closesAt,
                    snapshot: { timestamp: value.marketNow, blockNumber: value.blockNumber, blockHash: value.blockHash },
                    prices: [{ event: 0, yes: value.prices.yes, no: value.prices.no }] };
                } } }));
            }
            return send(res, 200, await hybridPriceArchives.get(id).read());
          }
          if (op === '' && req.method === 'GET') {
            const wallet = url.searchParams.get('wallet');
            if ([...url.searchParams.keys()].some(key => key !== 'wallet'))
              return send(res, 400, { error: 'Unexpected parameter.' });
            return send(res, 200, await hybrid.snapshot(id, wallet));
          }
          if (url.search || req.method !== 'POST') return send(res, 405, { error: 'POST without parameters required.' });
          const input = await body(req);
          if (op === 'analysis') return send(res, 200, await hybrid.analysis(id, input));
          if (op === 'evidence') {
            if (!oracleEvidenceStore) return send(res, 503, { error: 'Evidence storage unavailable.' });
            const route = hybrid.routeFor(id);
            return send(res, 200, route.event.route === 'mechanical'
              ? await oracleEvidenceStore.putHybridChallenge(route, login.address, input)
              : await oracleEvidenceStore.put({ id, questionId: route.event.source.questionId,
                  pool: route.pool, eventIndex: route.eventIndex }, login.address, input));
          }
          if (op === 'action') return send(res, 200, await hybrid.prepare(id, input.action, input.input || {}, input.owner));
          return send(res, 404, { error: 'Hybrid action unavailable.' });
        } catch (error) {
          return send(res, 400, { error: error instanceof Error && /^(Invalid |Hybrid |Challenge |Enter |Select |Choose |Wallet |Shares |Trading |Fund |Approval |Allow |Insufficient |Reality |Provide |Kleros |Bond |Evidence |Appeal |No |This |Sepolia )/.test(error.message)
            ? error.message : 'Market request unavailable. Refresh and retry.' });
        }
      }
      if(url.pathname==='/api/practice-collections'){
        const login=await getLogin();
        if(!login||login.method!=='passkey')return send(res,401,{error:'Sign in with your Flurbo passkey'});
        if(req.method!=='GET'||url.search)return send(res,400,{error:'Collection listing accepts a GET without parameters'});
        if(!practiceCollections)return send(res,503,{error:'Practice collections are unavailable'});
        return send(res,200,practiceCollections.catalog);
      }
      const archiveNamespace=url.pathname.match(/^\/api\/(practice-[0-9a-f]{40})\//)?.[1];
      if(url.pathname.startsWith('/api/pilot/')||archiveNamespace) {
        const pilot=archiveNamespace?practiceCollections?.services.get(archiveNamespace):publishedPilot;
        if(archiveNamespace)url.pathname=url.pathname.replace('/api/'+archiveNamespace+'/','/api/pilot/');
        // Content-addressed evidence is public so counterparties can inspect a cited URI.
        const evidenceHash=url.pathname.match(/^\/api\/pilot\/evidence\/(0x[0-9a-f]{64})$/)?.[1];
        if(evidenceHash && req.method==='GET' && !url.search && evidence) {
          const content=await evidence.get(evidenceHash);
          res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'public, max-age=31536000, immutable'}); res.end(content); return;
        }
        const login=await getLogin();
        if(!login || login.method!=='passkey') return send(res,401,{error:'Sign in with your Flurbo passkey'});
        if(!pilot) return send(res,archiveNamespace?404:503,{error:archiveNamespace?'That market collection is not available.':'The real-event pilot is not published yet. Reviewer identities, final event rules and a verified deployment are required.'});
        if(req.method==='GET' && ['/api/pilot/status','/api/pilot/account'].includes(url.pathname)) {
          if([...url.searchParams.keys()].some(k=>k!=='wallet') || url.searchParams.getAll('wallet').length>1) return send(res,400,{error:'Invalid pilot query'});
          if(url.pathname==='/api/pilot/account') return send(res,200,await pilot.account(url.searchParams.get('wallet')));
          return send(res,200,await pilot.status(url.searchParams.get('wallet')||undefined));
        }
        if(url.search) return send(res,400,{error:'Unexpected pilot query'});
        if(req.method==='POST' && url.pathname==='/api/pilot/validate-trade') {
          try { return send(res,200,assessSemantics(pilot.manifest,await body(req))); }
          catch(e) { return send(res,e.status===400?400:503,{code:e.status===400?'INVALID_INPUT':'SEMANTICS_UNAVAILABLE',error:e.status===400?e.message:'The semantic check is unavailable. Retry before trading.'}); }
        }
        if(req.method==='GET' && url.pathname==='/api/pilot/price-history') {
          if(!store.command)return send(res,503,{error:'Price history storage is unavailable.'});
          try{
            if(!priceArchives.has(pilot))priceArchives.set(pilot,priceHistory({service:pilot,command:store.command}));
            return send(res,200,await priceArchives.get(pilot).read());
          }catch{return send(res,503,{error:'Price history is temporarily unavailable. Trading is separate.'});}
        }
        if(req.method==='GET' && url.pathname==='/api/pilot/markets') return send(res,200,await pilot.markets());
        if(req.method==='POST' && url.pathname==='/api/pilot/analytics') {
          const input=await body(req);
          if(!input||Array.isArray(input)||Object.keys(input).sort().join(',')!=='a,b'||![input.a,input.b].every(x=>Number.isInteger(x)&&x>=0&&x<pilot.manifest.publication.draft.events.length)||input.a===input.b) return send(res,400,{error:'Choose two different events.'});
          try {if(!pilot.analytics)throw new Error('Unavailable');return send(res,200,await pilot.analytics(input));}
          catch {return send(res,503,{error:'This comparison is temporarily unavailable. Try again shortly. Trading is separate.'});}
        }
        if(req.method==='POST' && url.pathname==='/api/pilot/claim-analytics') {
          const input=await body(req);
          try {
            if(!input||Array.isArray(input)||Object.keys(input).sort().join(',')!=='mask,scope')throw Error('Invalid input');
            validateClaim(input.scope,input.mask,pilot.manifest.publication.draft.events.length);
          }catch{return send(res,400,{error:'Choose a supported claim in this pool.'});}
          try {if(!pilot.claimAnalytics)throw Error('Unavailable');return send(res,200,await pilot.claimAnalytics(input));}
          catch{return send(res,503,{error:'This comparison is temporarily unavailable. Trading is separate.'});}
        }
        if(req.method==='POST' && url.pathname==='/api/pilot/thesis') {
          const input=await body(req);
          try{validateThesisInput(input,pilot.manifest.publication.draft.events.length);}
          catch{return send(res,400,{error:'Choose two questions and a supported share quantity.'});}
          try{if(!pilot.thesisAnalytics)throw Error('Unavailable');return send(res,200,await pilot.thesisAnalytics(input));}
          catch{return send(res,503,{error:'The pool comparison could not load. Your view is still available; retry shortly.'});}
        }
        if(req.method==='POST' && url.pathname==='/api/pilot/prepare') {
          const input = await body(req);
          if (!['buy','sell','redeem','dispute','withdrawBond'].includes(input?.action) && !isTestingOperator(login, testingOperatorAccount)) return send(res,403,{error:'Testing tools are restricted to the operator.'});
          // Buying and selling go only through wallets linked to this Flurbo account, so every bet made on the
          // site belongs to a member. Redeeming stays open so winnings can never be stranded.
          if(['buy','sell'].includes(input?.action)){
            if(hosted&&!store.command)return send(res,503,{error:'Account wallet storage is unavailable.'});
            const {wallets}=await links.list(login.address,origin);
            if(!wallets.includes(String(input.owner||'').toLowerCase()))return send(res,403,{code:'WALLET_NOT_LINKED',error:'Link this MetaMask wallet to your Flurbo account before trading.'});
          }
          if(input?.action==='dispute'){
            if(input.authorization||input.signature)return send(res,400,{error:'Request a fresh account eligibility check.'});
            if(hosted&&!store.command)return send(res,503,{error:'Account wallet storage is unavailable.'});
            const {wallets}=await links.list(login.address,origin),{stake,...action}=input;
            if(!wallets.includes(input.owner?.toLowerCase())||!wallets.includes(stake?.holder?.toLowerCase()))return send(res,403,{error:'Link both MetaMask wallets to your Flurbo account before challenging.'});
            if(!pilot.challengeStake||!(await pilot.challengeStake(input.event,stake)).eligible)return send(res,403,{error:'Your account needs shares in this event to challenge its answer.'});
            if(pilot.manifest.challengePolicy){
              try{return send(res,200,await pilot.prepare({...action,...await authorizeHolder(pilot,login,wallets,input)}));}
              catch{return send(res,503,{error:'Challenge authorization could not be prepared. Refresh eligibility and retry before the deadline.'});}
            }
            return send(res,200,await pilot.prepare(action));
          }
          return send(res,200,await pilot.prepare(input));
        }
        if(req.method==='POST'&&url.pathname==='/api/pilot/challenge-eligibility'){
          if(hosted&&!store.command)return send(res,503,{error:'Account wallet storage is unavailable.'});
          const input=await body(req);
          if(!input||Object.keys(input).some(k=>!['owner','event','cursor','stake'].includes(k)))return send(res,400,{error:'Invalid eligibility request.'});
          const {wallets}=await links.list(login.address,origin);
          if(!wallets.includes(input.owner?.toLowerCase()))return send(res,403,{error:'Link this MetaMask wallet to your Flurbo account first.'});
          if(input.stake){
            if(!wallets.includes(input.stake.holder?.toLowerCase()))return send(res,403,{error:'Qualifying shares must belong to this Flurbo account.'});
            return send(res,200,await pilot.challengeStake(input.event,input.stake));
          }
          return send(res,200,await pilot.challengeEligibility(wallets,input.event,input.cursor??0));
        }
        if(req.method==='POST' && url.pathname==='/api/pilot/position') {
          const input=await body(req); return send(res,200,await pilot.position(input.owner,input.scope,input.mask));
        }
        if(req.method==='POST' && url.pathname==='/api/pilot/positions') {
          const input=await body(req); return send(res,200,await pilot.positions(input.owner,input.claims));
        }
        if(req.method==='POST' && url.pathname==='/api/pilot/collected-payouts') {
          const input=await body(req);
          if(!pilot.payouts||Object.keys(input).length)return send(res,400,{error:'Payout history unavailable or unexpected input'});
          try{await pilot.snapshot();return send(res,200,await pilot.payouts.refresh());}
          catch(error){
            const code=error?.code==='PAYOUT_ARCHIVE_UNAVAILABLE'?'PAYOUT_ARCHIVE_UNAVAILABLE':'PAYOUT_READ_FAILED';
            console.warn(JSON.stringify({status:'payout_read_failed',pool:pilot.manifest.pool,code}));
            return send(res,503,{code,error:'Collected payouts could not be checked. Your current holdings are separate.'});
          }
        }
        if(req.method==='POST' && url.pathname==='/api/pilot/history') {
          const input=await body(req);
          if(!pilot.index || Object.keys(input).length) return send(res,400,{error:'Pilot history unavailable or unexpected input'});
          try {
            await pilot.snapshot();
            return send(res,200,await pilot.index.refresh());
          } catch {
            return send(res,503,{error:'Trade history is temporarily unavailable. Your on-chain holdings are loaded separately. Retry shortly.'});
          }
        }
        if(req.method==='POST' && url.pathname==='/api/pilot/evidence') {
          if(!evidence) return send(res,503,{error:'Evidence storage unavailable'});
          const input=await body(req);
          const event=pilot.manifest.publication.draft.events.findIndex(e=>e.id===input?.eventId);
          if(event<0) return send(res,400,{error:'Unknown pilot event'});
          if (!isTestingOperator(login, testingOperatorAccount)) {
            const state=await pilot.status(), current=state.cases[event];
            if(current.phase!==1 || Number(current.challengeUntil)<=state.snapshot.timestamp || ![1,2,3].includes(input.outcome) || current.proposal===input.outcome)
              return send(res,409,{error:'Choose a different answer during the open challenge period.'});
          }
          return send(res,200,await evidence.put(input,login.address,pilot.manifest.draftHash));
        }
        if(req.method==='POST' && url.pathname==='/api/pilot/rpc') {
          const input=await body(req);
          if(!input || !Array.isArray(input.params) || !['eth_chainId','eth_getBlockByNumber','eth_getCode','eth_call','eth_estimateGas','eth_gasPrice','eth_getTransactionCount','eth_getTransactionReceipt','eth_getTransactionByHash','eth_getBalance','eth_sendRawTransaction'].includes(input.method)) return send(res,400,{error:'Unsupported pilot RPC'});
          if(input.method==='eth_sendRawTransaction') return send(res,403,{error:'Mera is account-only. Send transactions through MetaMask.'});
          const upstream=await rpcFetch(fetch,rpcUrl,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:input.method,params:input.params}),signal:AbortSignal.timeout(20_000)});
          const result=await upstream.json();
          if(!upstream.ok || result.error) return send(res,400,{error:'Monad rejected the pilot request. Check tracking before retrying.'});
          return send(res,200,{result:result.result});
        }
        return send(res,404,{error:'Unknown pilot endpoint'});
      }
      if (['/api/learning/pool', '/api/learning/proposal'].includes(url.pathname)) {
        const session = await getLogin();
        if (!session || session.method !== 'passkey') return send(res, 401, { error: 'Sign in with your Flurbo passkey' });
        if (url.search) return send(res, 400, { error: 'Learning review accepts no query inputs' });
        const operator = Boolean(learningOperatorAccount && session.address === learningOperatorAccount);
        if (url.pathname === '/api/learning/pool') {
          if (req.method !== 'GET') return send(res, 405, { error: 'Pool status is read-only' });
          if (!learningPool) return send(res, 503, { error: 'Learning pool reader unavailable' });
          return send(res, 200, { ...await learningPool.status(), operator });
        }
        if (req.method !== 'POST') return send(res, 405, { error: 'Use explicit proposal preparation' });
        if (!operator) return send(res, 403, { error: 'Learning operator account required' });
        const input = await body(req);
        if (!input || Array.isArray(input) || typeof input !== 'object' || Object.keys(input).length) return send(res, 400, { error: 'This synthetic fixture accepts no custom inputs' });
        if (!learningPool) return send(res, 503, { error: 'Learning pool reader unavailable' });
        return send(res, 200, await learningPool.prepare());
      }
      if (url.pathname === '/api/learning/comparison') {
        if (req.method !== 'GET') return send(res, 405, { error: 'Comparison is read-only' });
        if (!await getLogin()) return send(res, 401, { error: 'Sign in to view the comparison' });
        if (url.search) return send(res, 400, { error: 'This comparison accepts no inputs' });
        const learningReport = getLearningReport();
        return learningReport ? send(res, 200, learningReport) : send(res, 503, { error: 'Rust comparison is unavailable on this server. Trading is separate.' });
      }
      if (hosted && url.pathname === '/api/local-wallet-setup') return send(res, 404, { error: 'Local funding is not available on public Monad testnet' });
      if (url.pathname.startsWith('/api/auth/')) {
        if (req.method === 'GET' && url.pathname === '/api/auth/session') { const session = await getLogin(); res.setHeader('Set-Cookie', toolsCookie(session, sid)); return send(res, 200, {session}); }
        if (req.method !== 'POST') return send(res, 405, { error: 'Method unavailable' });
        if (url.pathname === '/api/auth/challenge') {
          const input = await body(req);
          if (input.method !== undefined && input.method !== 'passkey') return send(res, 400, { error: 'Use your Flurbo passkey to sign in. Extension wallets are for trading after login.' });
          const challenge = await store.challenge(input.address, origin, 'passkey');
          res.setHeader('Set-Cookie', cookie('flurbo_challenge', challenge.id, 300));
          return send(res, 200, { message: challenge.message });
        }
        if (url.pathname === '/api/auth/verify') {
          const input = await body(req);
          const session = await store.verify(cookieValue(req.headers.cookie, 'flurbo_challenge'), input.signature, origin);
          if (metrics && session.method === 'passkey') void metrics.recordSignIn(session.address).catch(() => {});
          await store.revoke(sid);
          res.setHeader('Set-Cookie', [cookie('flurbo_session', session.sessionId, LOGIN_MS / 1000), cookie('flurbo_challenge', '', 0), toolsCookie(session, session.sessionId)]);
          return send(res, 200, { session: { address: session.address, expiresAt: session.expiresAt, method: session.method } });
        }
        if (url.pathname === '/api/auth/logout') {
          await store.revoke(sid);
          res.setHeader('Set-Cookie', [cookie('flurbo_session', '', 0), cookie('flurbo_challenge', '', 0), toolsCookie(null, '')]);
          return send(res, 200, { session: null });
        }
        return send(res, 404, { error: 'Unknown account endpoint' });
      }
      if (url.pathname === '/api/rpc' && req.method === 'POST') {
        const input = await body(req);
        const market = input.market ?? 'original';
        if (!['original', 'learning'].includes(market)) return send(res, 400, { error: 'Unknown trading market' });
        if (market === 'learning' && (!hosted || !learningDashboardUrl)) return send(res, 503, { error: 'Learning market unavailable' });
        const allowed = ['eth_chainId', 'eth_getBlockByNumber', 'eth_call', 'eth_estimateGas', 'eth_gasPrice', 'eth_getTransactionCount', 'eth_getTransactionReceipt', 'eth_getTransactionByHash', 'eth_getBalance', 'eth_sendRawTransaction'];
        if (!allowed.includes(input.method) || !Array.isArray(input.params)) return send(res, 400, { error: 'Unsupported RPC method' });
        if ((hosted || input.method === 'eth_sendRawTransaction') && !await getLogin()) return send(res, 401, { error: 'Sign in before using the account RPC' });
        if (input.method === 'eth_sendRawTransaction') return send(res,403,{error:'Mera is account-only. Send transactions through MetaMask.'});
        const upstream = await rpcFetch(fetch,rpcUrl, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: input.method, params: input.params }), signal: AbortSignal.timeout(20_000) });
        const result = await upstream.json();
        if (!upstream.ok || result.error) return send(res, 400, { error: 'Monad rejected the request. Check transaction status before retrying.' });
        return send(res, 200, { result: result.result });
      }
      const readRoutes = ['/api/health', '/api/state', '/api/quote', '/api/transaction', '/api/portfolio'];
      const learningRoute = url.pathname.startsWith('/api/markets/learning/');
      const readPath = learningRoute ? url.pathname.replace('/api/markets/learning/', '/api/') : url.pathname;
      if (readPath === '/api/portfolio' && !await getLogin()) return send(res, 401, { error: 'Sign in to view your portfolio' });
      if (learningRoute) {
        if (!hosted || !learningDashboardUrl) return send(res, 503, { error: 'Learning market unavailable' });
        if (!await getLogin()) return send(res, 401, { error: 'Sign in to trade on the learning market' });
      }
      const funding = !hosted && req.method === 'POST' && url.pathname === '/api/local-wallet-setup';
      if (!(req.method === 'GET' && readRoutes.includes(readPath)) && !funding) return send(res, 404, { error: 'Unknown workspace endpoint' });
      const input = funding ? await body(req) : undefined;
      const upstream = await fetch(`${learningRoute ? learningDashboardUrl : dashboardUrl}${readPath}${url.search}`, { method: funding ? 'POST' : 'GET', redirect: 'error',
        headers: funding ? { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:18765' } : {},
        body: funding ? JSON.stringify(input) : undefined, signal: AbortSignal.timeout(20_000) });
      const result = await upstream.json();
      if (hosted && upstream.ok && ['state', 'quote', 'transaction', 'portfolio'].includes(readPath.split('/').pop()) &&
          (result.environment !== 'public_testnet' || result.chain_id !== 10143 || learningRoute &&
            (result.market_id !== 'learning' || result.contracts?.pool !== learningDeployment.pool || result.contracts?.cash !== TESTNET.cash))) return send(res, 503, { error: 'Public testnet deployment verification required' });
      return send(res, upstream.status, result);
    } catch(e) { if(e instanceof CapacityError){res.setHeader('Retry-After',String(e.retryAfter));return send(res,429,{code:e.code,error:e.message});} if(e instanceof ApplicationError){if(e.status===429)res.setHeader('Retry-After','60');return send(res,e.status,{error:e.message});} return send(res, 503, { error: 'Service unavailable or request rejected. Refresh before retrying. No automatic transaction retry is performed.' }); }
  };
  handler.metrics = metrics;
  handler.notices = notices;
  return handler;
}
