import {requestLimits,CapacityError,expensivePath,memoryWindow} from './request-limits.mjs';
import {clientAddressReader} from './client-address.mjs';
import {envioProxy} from './envio-proxy.mjs';
import {rpcFetch} from './rpc-capacity.mjs';
import { SessionStore, cookieValue, LOGIN_MS, digest } from './session.mjs';
import { TESTNET, HOSTED_ORIGINS } from './network.mjs';
import { learningDeployment } from '../shared/learning-contracts.mjs';
import { priceHistory } from './price-history.mjs';
import { walletLinks } from './wallet-links.mjs';
import { isTestingOperator, DEFAULT_TESTING_OPERATOR } from './testing-access.mjs';
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
  applications = null, previewAccess = null, testingOperatorAccount = DEFAULT_TESTING_OPERATOR, testFaucet = null, learningPool = null, learningOperatorAccount = null, learningDashboardUrl = null, agentPools = null, evidence = null, settlementPackets = null, starter = null, funding = null, oracle = null, oracleEvidenceStore = null, hybridNotices = [], hybrid = null, hybridPortfolio = null, proofCaptures = null, conditionals = null,
  envioUrl = null, clientAddress = clientAddressReader(), now = Date.now } = {}) {
  const hosted = publicOrigin !== null;
  // Agent wallets cannot also be linked for manual MetaMask trading; with Redis the two claims exclude each other atomically.
  const links = walletLinks({command:store.command,isReserved:wallet=>agents?agents.isAgentWallet(wallet):false,reservedKey:store.command?agentWalletKey:null});
  // Operator addresses of every catalog pool, plus FLURBO_AGENT_RESERVED_WALLETS, can never be agent wallets.
  const reservedWallets=new Set((process.env.FLURBO_AGENT_RESERVED_WALLETS||'').split(',').map(x=>x.trim().toLowerCase()).filter(x=>/^0x[0-9a-f]{40}$/.test(x)));
  for(const a of agentPools?.reservedAddresses??[])reservedWallets.add(a.toLowerCase());
  // Hybrid pools with two to thirty-two questions, served to agents as practice-<pool address without 0x>.
  const agentServices=agentPools?.services??new Map();
  const labelOf=namespace=>agentPools?.collections?.find(c=>c.namespace===namespace)?.label??namespace;
  const previewAllows=previewAccess||applications?async account=>{
    const session={method:'passkey',address:account};
    if(isTestingOperator(session,testingOperatorAccount))return true;
    const legacy=previewAccess?await previewAccess.allows(session):false;
    return applications?applications.allows(account,legacy):legacy;
  }:null;
  const oraclePriceArchives=new Map();
  const hybridPriceArchives=new Map();
  // Agents: account-isolated profiles, paper trading and user-approved proposals. Never a signer.
  const agents=(()=>{try{return agentApi({command:store.command||null,hosted,links,localCounters:!sharedLimits,rpc:agentRpc(rpcUrl,{hosted}),previewAllows,reservedWallets,
    serviceFor:namespace=>agentServices.get(namespace)??null});}catch{return null;}})();
  // Operator-only growth metrics. Needs durable storage; members never see these numbers.
  const listedPools=()=>[...agentServices].map(([namespace,service])=>({namespace,label:labelOf(namespace),service})).filter(p=>p.service.index);
  const oracleNoticePools=oracle?.noticePools?.(store.command||null)||[];
  const metrics=userMetrics({command:store.command||null,origin:publicOrigin||`http://${hosts[0]}`,links,applications,operatorAccount:testingOperatorAccount,funding,
    openAccess:!previewAllows,reservedWallets,rpcUrl,pools:listedPools});
  // Email notices to members about their own positions and settlement stages. Hybrid notices already cover
  // every hybrid pool, agent pools included, so the agent pool services are not listed again.
  const notices=memberNotices({command:store.command||null,pools:()=>[...oracleNoticePools,...hybridNotices],applications,links,origin:publicOrigin||`http://${hosts[0]}`,
    send:applications?.noticeEmail?noticeDelivery(applications.noticeEmail):null});
  const page=(res,status,title,body)=>{res.writeHead(status,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} | flurbo</title></head><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 16px;color:#14271d;background:#f5f4ec;line-height:1.5"><h1 style="font-size:1.5rem">${title}</h1>${body}</body></html>`);};
  if (hosted && (!HOSTED_ORIGINS.has(publicOrigin) || !rpcUrl.startsWith('https://'))) throw new Error('Invalid hosted API configuration');
  // Anonymous/public traffic never consumes authenticated account capacity. With sharedLimits off (a single
  // server), the rate windows count in memory instead of costing Redis commands on every request.
  const limits=requestLimits({command:sharedLimits?store.command:null,now});
  const cooldown=()=>new CapacityError(60-now()/1000%60);
  // Session cookies verified here in the last hour (digests only). They skip the unknown-cookie gate below, so
  // members keep working while a flood of made-up cookies is being refused.
  const recentSessions=new Map();
  const recentSession=sid=>(recentSessions.get(digest(sid))??0)>now();
  const rememberSession=sid=>{
    const key=digest(sid);recentSessions.delete(key);recentSessions.set(key,now()+3_600_000);
    if(recentSessions.size>20_000)recentSessions.delete(recentSessions.keys().next().value);
  };
  const publicPackets=settlementPackets?settlementPacketHandler(settlementPackets):null;
  const send = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(body)); };
  // Hosted cookies are __Host- cookies, which a sibling *.singu.online host cannot set or overwrite. The earlier
  // names are still read, and cleared at sign-in and sign-out, so nobody is signed out by the rename.
  const cookieName = name => (hosted ? '__Host-flurbo_' : 'flurbo_') + name;
  const readCookie = (header, name) => cookieValue(header, cookieName(name)) ?? (hosted ? cookieValue(header, 'flurbo_' + name) : undefined);
  const cookie = (name, value, age) => `${cookieName(name)}=${value}; HttpOnly; SameSite=Strict; Path=${hosted || name === 'tools' ? '/' : '/api'}; Max-Age=${age}${hosted ? '; Secure' : ''}`;
  const legacyCleared = () => hosted ? ['session', 'challenge', 'tools'].map(name => `flurbo_${name}=; HttpOnly; SameSite=Strict; Path=${name === 'tools' ? '/' : '/api'}; Max-Age=0; Secure`) : [];
  const toolsCookie = (session, sid) => cookie('tools', isTestingOperator(session, testingOperatorAccount) ? sid : '', isTestingOperator(session, testingOperatorAccount) ? Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1000)) : 0);
  // Verification emails per client address per day, so one network cannot spend the whole daily email budget.
  const APPLICATION_EMAILS_PER_ADDRESS = 20;
  const dailyWindow = store.command ? null : memoryWindow(now);
  async function dailyTake(key, limit) {
    const id = `flurbo:daily:v1:${digest(key)}:${new Date(now()).toISOString().slice(0, 10)}`;
    const count = store.command ? Number(await store.command('EVAL', "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return n", 1, id, '172800'))
      : await dailyWindow(id, 86_400);
    if (count > limit) throw new ApplicationError(429, 'Too many applications from this network today. Try again tomorrow.');
  }
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
    const ip = clientAddress(req);
    // Published immutable packets must be readable without a login, including by
    // counterparties following the evidence URI from outside the application.
    if(publicPackets&&req.url.startsWith(SETTLEMENT_PACKET_PATH)){
      try{limits.localTake('public-settlement-packets:'+ip,60);limits.localTake('public-settlement-packets',600);await publicPackets(req,res);}
      catch(error){if(error instanceof CapacityError){res.setHeader('Retry-After',String(error.retryAfter));return send(res,429,{error:'Public evidence request limit reached.'});}return send(res,503,{error:'Public evidence unavailable.'});}
      return;
    }
    if (req.method === 'GET' && req.url?.startsWith(EVIDENCE_PATH)) {
      const hash = req.url.slice(EVIDENCE_PATH.length);
      try {
        limits.localTake('oracle-public-evidence:' + ip, 120);
        limits.localTake('oracle-public-evidence', 1200);
        if (!oracleEvidenceStore) throw Error('Evidence unavailable');
        const value = await oracleEvidenceStore.get(hash);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
        res.end(value);
      } catch { send(res, 404, { error: 'Evidence unavailable' }); }
      return;
    }
    if (req.method === 'GET' && /^\/api\/hybrid\/rules\/0x[0-9a-f]{64}$/.test(req.url || '')) {
      try {
        limits.localTake('hybrid-public-rules:' + ip, 120);
        limits.localTake('hybrid-public-rules', 1200);
        const ruleHash = req.url.slice('/api/hybrid/rules/'.length);
        const value = [hybrid, conditionals].reduce((found, service) => {
          if (found !== null || !service) return found;
          try { return service.ruleFor(ruleHash); } catch { return null; }
        }, null);
        if (value === null) throw Error('Rule unavailable');
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
        res.end(value);
      } catch { send(res, 404, { error: 'Rule unavailable' }); }
      return;
    }
    if (req.url === PROOF_CAPTURE_PATH) {
      if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
      if (!proofCaptures) return send(res, 404, { error: 'Proof submission unavailable' });
      try { limits.localTake('proof-capture-submit:' + ip, 30); } catch { return send(res, 429, { error: 'Too many requests' }); }
      // The token is checked before the body is read, so callers without it never use the uploader's budget.
      if (proofCaptures.authorized && !proofCaptures.authorized(req.headers.authorization || '')) return send(res, 401, { error: 'Proof submission unauthorized' });
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
      try { limits.localTake('alchemy-webhook:' + ip, 120); limits.localTake('alchemy-webhook', 600); }
      catch { return send(res, 429, { error: 'Too many requests' }); }
      const signingKey = process.env.FLURBO_ALCHEMY_WEBHOOK_SIGNING_KEY || '';
      const signature = req.headers['x-alchemy-signature'] || '';
      if (!signingKey) return send(res, 503, { error: 'Alchemy webhook signing key is not configured' });
      if (!/^[0-9a-f]{64}$/i.test(signature)) return send(res, 401, { error: 'Invalid Alchemy webhook signature' });
      let text = '';
      for await (const chunk of req) {
        text += chunk;
        if (text.length > 500_000) return send(res, 413, { error: 'Payload too large' });
      }
      const result = await handleAlchemyWebhook({ rawBody: text, signature, signingKey });
      return send(res, result.status, result.body);
    }
    // Headless agent runtimes authenticate with a bearer credential only. Cookies are never read on these
    // routes, so the browser same-origin rules below do not apply; browsers are refused instead.
    if (req.url.startsWith('/api/agent-runtime/')) {
      try {
        limits.localTake('runtime-ingress:'+digest(req.headers.authorization||'anonymous'),180);
        if(hosted){
          // Addresses that keep sending unknown credentials are refused before any credential lookup.
          limits.localTake('runtime-address:'+ip,1800);
          if(limits.localCount('runtime-rejected:'+ip)>=60)throw cooldown();
          limits.localTake('runtime-ingress',12000);
        } else limits.localTake('runtime-ingress',3600);
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
        if (hosted && result.status === 401) limits.localTake('runtime-rejected:'+ip,Infinity);
        if (result.retryAfter) res.setHeader('Retry-After', String(result.retryAfter));
        return send(res, result.status, result.body);
      } catch(e) { if(e instanceof CapacityError){res.setHeader('Retry-After',String(e.retryAfter));return send(res,429,{code:e.code,error:e.message,retryable:true});} return send(res, 503, { code:'UNAVAILABLE', error:'The agent service is temporarily unavailable.', retryable:true }); }
    }
    const unsubscribe=req.url.match(/^\/api\/notifications\/unsubscribe\/([0-9a-zA-Zx.]{1,200})$/);
    if(unsubscribe){
      try{limits.localTake('notice-unsubscribe:'+ip,20);limits.localTake('notice-unsubscribe',600);}catch{return page(res,429,'Try again shortly','<p>Too many requests. Try again in a minute.</p>');}
      if(!notices)return page(res,503,'Unavailable','<p>Notices are not available right now.</p>');
      if(req.method==='GET')return page(res,200,'Stop Flurbo emails?',`<p>Stop all Flurbo notices about payouts, proposed answers, source windows and closing markets. You can turn them back on from Your account.</p><form method="post"><button type="submit" style="font:inherit;padding:10px 18px;border-radius:8px;border:0;background:#14271d;color:#f5f4ec;cursor:pointer">Stop all notices</button></form>`);
      if(req.method!=='POST')return page(res,405,'Not allowed','<p>Use the link in the email.</p>');
      for await(const chunk of req){if(chunk.length>2048)break;}
      const account=await notices.unsubscribe(unsubscribe[1]).catch(()=>null);
      return account?page(res,200,'You will not get Flurbo notices','<p>Done. You can turn notices back on from Your account at any time.</p>'):page(res,400,'Link not valid','<p>This unsubscribe link is not valid. Turn notices off from Your account instead.</p>');
    }
    const origin = publicOrigin || `http://${host}`;
    if ((req.headers.origin && req.headers.origin !== origin) || (req.method !== 'GET' && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site') return send(res, 403, { error: 'Same-origin request required' });
    const url = new URL(req.url, origin), sid = readCookie(req.headers.cookie, 'session');
    let loginPromise, approvalPromise;
    const getLogin=()=>loginPromise??=store.read(sid,origin);
    // Testnet approval of this request's verified login, looked up once per request.
    const approval=()=>approvalPromise??=Promise.resolve(getLogin()).then(login=>login?.method!=='passkey'?false:!previewAllows||previewAllows(login.address));
    try {
      if (hosted) {
        const publicRead=req.method==='GET'&&url.pathname==='/api/preview';
        if(publicRead){limits.localTake('public-preview:'+ip,120);limits.localTake('public-preview',3000);}
        else {
          // A cookie this process has not seen costs a storage read. Addresses that keep presenting unknown
          // cookies are refused before that read, and so is everyone once unknown cookies flood the whole site.
          if(sid&&!store.peek?.(sid,origin)&&!recentSession(sid)&&(limits.localCount('session-miss:'+ip)>=60||limits.localCount('session-miss')>=600))throw cooldown();
          const authenticated=await getLogin();
          if(sid&&!authenticated){limits.localTake('session-miss:'+ip,Infinity);limits.localTake('session-miss',Infinity);}
          else if(sid)rememberSession(sid);
          if(authenticated?.method==='passkey'){
            await limits.take('browser-account:'+authenticated.address.toLowerCase(),240);
            if(expensivePath(url.pathname))await limits.take('browser-expensive:'+authenticated.address.toLowerCase(),90);
            // Anyone can open a session with a fresh key, so accounts without testnet approval share their own
            // budget and can never use up the approved members' one.
            if(await approval().catch(()=>false))await limits.take('browser-authenticated-service',1200);
            else limits.localTake('browser-unapproved-service',600);
          } else {
            limits.localTake('anonymous:'+ip,120);
            limits.localTake('anonymous',3000);
            await limits.take('browser-anonymous',3000);
          }
        }
      }
      if (req.method === 'GET' && url.pathname === '/api/preview') return send(res,200,{inviteOnly:!!previewAllows,applicationUrl:applications?null:previewAccess?.applicationUrl||null,...(applications?{nativeApplications:true}:{})});
      if (url.pathname === '/api/semantic-status') {
        const login = await getLogin();
        if (!login || login.method !== 'passkey') return send(res, 401, {error:'Sign in first.'});
        if (!isTestingOperator(login, testingOperatorAccount)) return send(res, 403, {error:'Operator access only.'});
        if (req.method !== 'GET' || url.search) return send(res, 400, {error:'Semantic status accepts a GET without parameters'});
        const services = [...agentServices].map(([namespace, service]) => ({ namespace, manifest: service.manifest }));
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
        return send(res, 200, {testingTools:isTestingOperator(login, testingOperatorAccount),approved:await approval(),applicationUrl:applications?null:previewAccess?.applicationUrl||null,...(applications?{nativeApplications:true}:{})});
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
        const operator=isTestingOperator(login,testingOperatorAccount);
        const budget=async lane=>{
          await limits.take('applications:'+lane+':account:'+login.address.toLowerCase(),lane==='email'?3:20);
          await limits.take('applications:'+lane+':service',lane==='email'?10:120);
          if(hosted&&lane==='email'&&!operator)await dailyTake('application-email:'+ip,APPLICATION_EMAILS_PER_ADDRESS);
        };
        await budget('request');
        const input=req.method==='POST'?await body(req):{};
        return send(res,200,await applications.handle({action,account:login.address,input,operator,budget}));
      }
      // Guard every app data/action route, including legacy namespaces and RPC.
      // Published evidence stays readable by counterparties during settlement.
      const publicEvidence=req.method==='GET'&&!url.search&&/^\/api\/(pilot|practice-[0-9a-f]{40})\/evidence\/0x[0-9a-f]{64}$/.test(url.pathname);
      if(previewAllows&&!url.pathname.startsWith('/api/auth/')&&!publicEvidence){
        const login=await getLogin();
        if(!login||login.method!=='passkey')return send(res,401,{error:'Sign in with your Flurbo passkey.'});
        if(!await approval())return send(res,403,{code:'INVITE_REQUIRED',error:'Testnet access has not been approved for this Mera account.'});
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
      // Indexer reads for signed-in pages; the proxy accepts only its fixed queries.
      if(url.pathname==='/api/envio'){
        const login=await getLogin();
        if(!login||login.method!=='passkey')return send(res,401,{error:'Sign in first.'});
        if(url.search)return send(res,400,{error:'Unexpected parameter.'});
        await limits.take('envio:'+login.address.toLowerCase(),60);
        return envioProxy(req,res,envioUrl);
      }
      if (req.method === 'GET' && url.pathname === '/api/network') return send(res, 200, hosted ? {...TESTNET, faucet:testFaucet || TESTNET.faucet, flurboFaucet:!!testFaucet, starterMon:starter?.amountMon ?? null} : { environment: 'local_fork', chain_id: 10143 });
      if (req.method === 'GET' && url.pathname === '/api/alchemy/activity') return send(res, 200, getAlchemyActivities());
      if(url.pathname==='/api/market-directory'&&req.method==='GET'&&!url.search){
        const login=await getLogin();
        if(!login||login.method!=='passkey')return send(res,401,{error:'Sign in with your Flurbo passkey.'});
        const oracleMarkets=oracle&&await approval()?oracle.list():[];
        const hybridMarkets=hybrid&&await approval()?hybrid.list():[];
        return send(res,200,{schema:'flurbo.market-directory.v1',markets:agentPools?.collections??[],oracleMarkets,hybridMarkets});
      }
      if (url.pathname.startsWith('/api/learning/')) {
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
      if (url.pathname === '/api/oracle/markets' || /^\/api\/oracle\/[a-z0-9-]{1,64}(?:\/(?:action|evidence|market|price-history))?$/.test(url.pathname)) {
        const login = await getLogin();
        if (!login || login.method !== 'passkey') return send(res, 401, { error: 'Sign in first.' });
        if (!await approval()) return send(res, 403, { error: 'Account approval required.' });
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
        if (!await approval()) return send(res, 403, { error: 'Account approval required.' });
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
      if (/^\/api\/hybrid\/0x[0-9a-f]{40}-(?:[0-9]|[12][0-9]|3[01])(?:\/(?:market|action|analysis|web|evidence|price-history|what-if))?$/i.test(url.pathname)) {
        const login = await getLogin();
        if (!login || login.method !== 'passkey') return send(res, 401, { error: 'Sign in first.' });
        if (!await approval()) return send(res, 403, { error: 'Account approval required.' });
        if (!hybrid) return send(res, 503, { error: 'Hybrid markets are unavailable.' });
        const parts = url.pathname.split('/'), id = parts[3], op = parts[4] || '';
        // Each comparison reads the pool several times and runs a calculation process.
        if (hosted && op === 'analysis') await limits.take('hybrid-analysis:' + login.address.toLowerCase(), 30);
        if (hosted && op === 'web') await limits.take('hybrid-web:' + login.address.toLowerCase(), 12);
        if (hosted && op === 'what-if') await limits.take('hybrid-what-if:' + login.address.toLowerCase(), 60);
        try {
          if (op === 'web' && req.method === 'GET' && !url.search)
            return send(res, 200, await hybrid.web(id));
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
          if (op === 'what-if') return send(res, 200, await hybrid.whatIf(id, input));
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
      // Conditional pools: their own directory, chances, quotes, holdings and actions, plus the single-question routes
      // of the hybrid service built over the conditional catalog. Same sign-in, approval and error rules as hybrid markets.
      if (url.pathname === '/api/conditionals' || url.pathname.startsWith('/api/conditionals/')) {
        const login = await getLogin();
        if (!login || login.method !== 'passkey') return send(res, 401, { error: 'Sign in first.' });
        if (!await approval()) return send(res, 403, { error: 'Account approval required.' });
        if (!conditionals) return send(res, 503, { error: 'Conditional markets are unavailable.' });
        const match = url.pathname.match(/^\/api\/conditionals(?:\/(0x[0-9a-f]{40})(?:-([0-9]|[12][0-9]|3[01]))?(?:\/(holdings|chances|quote|action|what-if))?)?$/i);
        if (!match) return send(res, 404, { error: 'Conditional route unavailable.' });
        const [, pool, event, op = ''] = match, account = login.address.toLowerCase();
        try {
          if (event !== undefined) {
            const id = `${pool}-${event}`;
            if (op === '' && req.method === 'GET') {
              if ([...url.searchParams.keys()].some(key => key !== 'wallet')) return send(res, 400, { error: 'Unexpected parameter.' });
              return send(res, 200, await conditionals.questions.snapshot(id, url.searchParams.get('wallet')));
            }
            if (!['action', 'what-if'].includes(op) || url.search || req.method !== 'POST') return send(res, 405, { error: 'POST without parameters required.' });
            if (hosted && op === 'what-if') await limits.take('hybrid-what-if:' + account, 60);
            const input = await body(req);
            if (op === 'what-if') return send(res, 200, await conditionals.questions.whatIf(id, input));
            return send(res, 200, await conditionals.questions.prepare(id, input.action, input.input || {}, input.owner));
          }
          if (!pool || op === '' || op === 'holdings') {
            if (req.method !== 'GET' || (op === 'holdings' ? [...url.searchParams.keys()].some(key => key !== 'wallet') : url.search))
              return send(res, 405, { error: 'GET without other parameters required.' });
            if (!pool) return send(res, 200, await conditionals.list());
            if (op === '') return send(res, 200, await conditionals.pool(pool));
            if (hosted) await limits.take('conditional-holdings:' + account, 60);
            return send(res, 200, await conditionals.holdings(pool, url.searchParams.get('wallet')));
          }
          if (url.search || req.method !== 'POST' || op === 'what-if') return send(res, 405, { error: 'POST without parameters required.' });
          if (hosted && op === 'chances') await limits.take('conditional-chances:' + account, 60);
          if (hosted && op === 'quote') await limits.take('conditional-quote:' + account, 30);
          const input = await body(req);
          if (op === 'chances') return send(res, 200, await conditionals.chances(pool, input));
          if (op === 'quote') return send(res, 200, await conditionals.quote(pool, input, input?.owner));
          return send(res, 200, await conditionals.prepare(pool, input.action, input.input || {}, input.owner));
        } catch (error) {
          if (error instanceof CapacityError) throw error;
          if (error?.message === 'Conditional markets are unavailable.') return send(res, 503, { error: error.message });
          return send(res, 400, { error: error instanceof Error && /^(Invalid |Hybrid |Conditional |Challenge |Enter |Select |Choose |Wallet |Shares |Trading |Fund |Approval |Allow |Insufficient |Reality |Provide |Kleros |Bond |Evidence |Appeal |No |This |Sepolia )/.test(error.message)
            ? error.message : 'Market request unavailable. Refresh and retry.' });
        }
      }
      // What remains of the namespaced routes: public evidence (its URIs are committed on chain), and for agent pools
      // the market read, the RPC proxy and the semantic check that the Agents page uses.
      const namespace=url.pathname.match(/^\/api\/(pilot|practice-[0-9a-f]{40})\//)?.[1];
      if(namespace||url.pathname==='/api/practice-collections'){
        const evidenceHash=url.pathname.match(/^\/api\/(?:pilot|practice-[0-9a-f]{40})\/evidence\/(0x[0-9a-f]{64})$/)?.[1];
        if(evidenceHash && req.method==='GET' && !url.search && evidence) {
          const content=await evidence.get(evidenceHash);
          res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'public, max-age=31536000, immutable'}); res.end(content); return;
        }
        const login=await getLogin();
        if(!login || login.method!=='passkey') return send(res,401,{error:'Sign in with your Flurbo passkey'});
        const operation=namespace&&namespace!=='pilot'?url.pathname.slice(`/api/${namespace}/`.length):null;
        if(!(req.method==='GET'&&operation==='markets'||req.method==='POST'&&['rpc','validate-trade'].includes(operation))) return send(res,404,{error:'Unknown endpoint'});
        const service=agentServices.get(namespace);
        if(!service) return send(res,404,{error:'That market collection is not available.'});
        if(url.search) return send(res,400,{error:'Unexpected query'});
        if(operation==='markets') return send(res,200,await service.markets());
        if(operation==='validate-trade') {
          try { return send(res,200,assessSemantics(service.manifest,await body(req))); }
          catch(e) { return send(res,e.status===400?400:503,{code:e.status===400?'INVALID_INPUT':'SEMANTICS_UNAVAILABLE',error:e.status===400?e.message:'The semantic check is unavailable. Retry before trading.'}); }
        }
        const input=await body(req);
        if(!input || !Array.isArray(input.params) || !['eth_chainId','eth_getBlockByNumber','eth_getCode','eth_call','eth_estimateGas','eth_gasPrice','eth_getTransactionCount','eth_getTransactionReceipt','eth_getTransactionByHash','eth_getBalance','eth_sendRawTransaction'].includes(input.method)) return send(res,400,{error:'Unsupported RPC method'});
        if(input.method==='eth_sendRawTransaction') return send(res,403,{error:'Mera is account-only. Send transactions through MetaMask.'});
        const upstream=await rpcFetch(fetch,rpcUrl,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:input.method,params:input.params}),signal:AbortSignal.timeout(20_000)});
        const result=await upstream.json();
        if(!upstream.ok || result.error) return send(res,400,{error:'Monad rejected the request. Check tracking before retrying.'});
        return send(res,200,{result:result.result});
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
          // The site-wide login budget is small; one address may use only part of it.
          if (hosted) limits.localTake('login-challenge:' + ip, 10);
          const input = await body(req);
          if (input.method !== undefined && input.method !== 'passkey') return send(res, 400, { error: 'Use your Flurbo passkey to sign in. Extension wallets are for trading after login.' });
          const challenge = await store.challenge(input.address, origin, 'passkey');
          res.setHeader('Set-Cookie', cookie('challenge', challenge.id, 300));
          return send(res, 200, { message: challenge.message });
        }
        if (url.pathname === '/api/auth/verify') {
          const input = await body(req);
          const session = await store.verify(readCookie(req.headers.cookie, 'challenge'), input.signature, origin);
          if (metrics && session.method === 'passkey') void metrics.recordSignIn(session.address).catch(() => {});
          await store.revoke(sid);
          res.setHeader('Set-Cookie', [cookie('session', session.sessionId, LOGIN_MS / 1000), cookie('challenge', '', 0), toolsCookie(session, session.sessionId), ...legacyCleared()]);
          return send(res, 200, { session: { address: session.address, expiresAt: session.expiresAt, method: session.method } });
        }
        if (url.pathname === '/api/auth/logout') {
          await store.revoke(sid);
          res.setHeader('Set-Cookie', [cookie('session', '', 0), cookie('challenge', '', 0), toolsCookie(null, ''), ...legacyCleared()]);
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
