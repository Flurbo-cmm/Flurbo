import {loadSemanticConfig} from '../server/semantic-validation.mjs';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {request as httpRequest} from 'node:http';
import {alice,bob,origin,fakeRedis} from './agent-fixture.ts';
import {previewAccess} from '../server/preview-access.mjs';
import {TESTNET} from '../server/network.mjs';
import {productionServer} from '../server/production.mjs';
import {pilotFixture} from './pilot-fixture.ts';

// The HTTP boundary of the headless runtime API on the production server: bearer credentials without
// browser headers, no cookies, no query strings, same session and invite rules for issuing credentials.
test('runtime routes over HTTP: bearer only, no cookies, no query strings, no browsers',async()=>{
  const fixture=pilotFixture(),redis=fakeRedis();
  const policy=previewAccess({FLURBO_TESTNET_APPROVED_ACCOUNTS:alice});
  const store={command:redis.command,read:async(id:string)=>id==='approved'?{address:alice,method:'passkey'}:id==='pending'?{address:bob,method:'passkey'}:null};
  const server=productionServer({origin,rpcUrl:TESTNET.rpc,previewAccess:policy,pilot:fixture.service,pilotEvidence:{get:async()=>'{}'}},store);
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const request=(path:string,{headers={} as Record<string,string>,body=undefined as object|undefined}={}):Promise<any>=>new Promise((resolve,reject)=>{
    const req=httpRequest({hostname:'127.0.0.1',port:(server.address() as any).port,path,method:body?'POST':'GET',headers:{host:'flurbo.singu.online',...(body?{'content-type':'application/json'}:{}),...headers}},
      res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,data:text?JSON.parse(text):null}));});
    req.on('error',reject);req.end(body?JSON.stringify(body):undefined);
  });
  const browser={origin,cookie:'flurbo_session=approved'};
  try{
    assert.equal((await request('/api/account/portfolio-sources')).status,401);
    assert.equal((await request('/api/account/portfolio-sources',{headers:{origin,cookie:'flurbo_session=pending'}})).status,403);
    assert.deepEqual((await request('/api/account/portfolio-sources',{headers:browser})).data,{account:alice,wallets:[],agentWallets:[],agentExecutions:[]});
    assert.equal((await request('/api/account/portfolio-sources?account='+bob,{headers:browser})).status,400);
    // Issuing needs the signed-in, approved browser session like every account route.
    const agent=(await request('/api/agents',{headers:browser,body:{kind:'runtime',name:'Hosted runtime',markets:['pilot']}})).data;
    assert.ok(agent.id,JSON.stringify(agent));
    assert.equal((await request(`/api/agents/${agent.id}/credentials`,{headers:{origin,cookie:'flurbo_session=pending'},body:{scopes:['runtime:report']}})).status,403,'invite required');
    const issued=(await request(`/api/agents/${agent.id}/credentials`,{headers:browser,body:{scopes:['markets:read','runtime:report']}})).data;
    assert.match(issued.token,/^fla1_/);
    const bearer={authorization:'Bearer '+issued.token,'flurbo-agent-protocol':'1'};
    const claim={scope:3,mask:'8',quantityAtoms:'1000000'};
    assert.equal((await request('/api/pilot/validate-trade',{body:claim,headers:{origin}})).status,401);
    assert.equal((await request('/api/pilot/validate-trade',{body:claim,headers:{origin,cookie:'flurbo_session=pending'}})).status,403);
    assert.equal((await request('/api/pilot/validate-trade',{body:claim,headers:{cookie:'flurbo_session=approved'}})).status,403);
    // Off by default: both routes answer with a claim-bound "disabled" assessment.
    const off=await request('/api/pilot/validate-trade',{body:claim,headers:browser});
    assert.equal(off.status,200,JSON.stringify(off.data));assert.equal(off.data.mode,'disabled');assert.equal(off.data.matrix,undefined);
    assert.equal((await request('/api/agent-runtime/v1/markets/pilot/validate-trade',{body:claim,headers:bearer})).data.mode,'disabled');
    loadSemanticConfig({FLURBO_SEMANTIC_MODE:'enforce'});
    try {
      const manual=await request('/api/pilot/validate-trade',{body:claim,headers:browser});
      assert.equal(manual.status,200,JSON.stringify(manual.data));assert.equal(manual.data.status,'unknown');assert.equal(manual.data.mode,'enforced');
      const assessment=await request('/api/agent-runtime/v1/markets/pilot/validate-trade',{body:claim,headers:bearer});
      assert.equal(assessment.status,200,JSON.stringify(assessment.data));assert.deepEqual(assessment.data.matrix,manual.data.matrix);
    } finally { loadSemanticConfig({}); }
    assert.equal((await request('/api/agent-runtime/v1/markets/rehearsal/validate-trade',{body:claim,headers:bearer})).status,404);
    assert.equal((await request('/api/agent-runtime/v1/markets/pilot/validate-trade',{body:{...claim,predicates:[]},headers:bearer})).status,400);
    assert.equal((await request('/api/agent-runtime/v1/markets/pilot/validate-trade',{body:claim,headers:{...bearer,'sec-fetch-site':'same-origin'}})).status,403);
    // Headless: no Origin header, POST allowed without the browser same-origin rule.
    const session=await request('/api/agent-runtime/v1/session',{headers:bearer});
    assert.equal(session.status,200,JSON.stringify(session.data));assert.equal(session.data.agentId,agent.id);
    const beat=await request('/api/agent-runtime/v1/heartbeat',{headers:bearer,body:{runtimeId:'http-1',sdk:{language:'typescript',version:'0.2.0'},mode:'paper',state:'running',
      policy:{hash:'b'.repeat(64),flurboVersion:1,summary:{}},pending:0,startedAt:Math.floor(Date.now()/1000)}});
    assert.equal(beat.status,200,JSON.stringify(beat.data));
    // Cookies never authenticate the runtime API.
    assert.equal((await request('/api/agent-runtime/v1/session',{headers:{cookie:'flurbo_session=approved','flurbo-agent-protocol':'1'}})).data.code,'UNAUTHENTICATED');
    // Credentials are never accepted in a query string.
    assert.equal((await request('/api/agent-runtime/v1/session?token='+issued.token,{headers:bearer})).status,400);
    // Browsers are refused, even with a valid token.
    assert.equal((await request('/api/agent-runtime/v1/session',{headers:{...bearer,'sec-fetch-site':'cross-site','sec-fetch-mode':'cors',origin:'https://example.com'}})).data.code,'BROWSER_NOT_SUPPORTED');
    // Error bodies never echo the token.
    const wrong=await request('/api/agent-runtime/v1/session',{headers:{...bearer,authorization:'Bearer '+issued.token.slice(0,-2)+'zz'}});
    assert.equal(wrong.status,401);assert.ok(!JSON.stringify(wrong.data).includes(issued.token.slice(22)));
    // The cookie-based application routes still require same origin.
    assert.equal((await request('/api/agents',{headers:{cookie:'flurbo_session=approved'},body:{kind:'runtime',name:'No origin',markets:['pilot']}})).status,403);
  }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});

test('operator semantic status reports the effective mode and isolates a misconfigured market',async()=>{
  const fixture=pilotFixture(),redis=fakeRedis();
  const store={command:redis.command,read:async(id:string)=>id==='operator'?{address:alice,method:'passkey'}:id==='member'?{address:bob,method:'passkey'}:null};
  const server=productionServer({origin,rpcUrl:TESTNET.rpc,previewAccess:null,testingOperatorAccount:alice,pilot:fixture.service,pilotEvidence:{get:async()=>'{}'}},store);
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const request=(path:string,cookie:string,body?:object):Promise<any>=>new Promise((resolve,reject)=>{
    const req=httpRequest({hostname:'127.0.0.1',port:(server.address() as any).port,path,method:body?'POST':'GET',headers:{host:'flurbo.singu.online',origin,cookie:'flurbo_session='+cookie,...(body?{'content-type':'application/json'}:{})}},
      res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,data:text?JSON.parse(text):null}));});
    req.on('error',reject);req.end(body?JSON.stringify(body):undefined);
  });
  const claim={scope:3,mask:'8',quantityAtoms:'1000000'};
  try{
    assert.equal((await request('/api/semantic-status','none')).status,401);
    assert.equal((await request('/api/semantic-status','member')).status,403);
    const off=await request('/api/semantic-status','operator');
    assert.equal(off.status,200,JSON.stringify(off.data));assert.equal(off.data.mode,'disabled');assert.deepEqual(off.data.markets.map((m:any)=>[m.namespace,m.status]),[['pilot','disabled']]);
    const pool=fixture.manifest.pool.toLowerCase();
    loadSemanticConfig({FLURBO_SEMANTIC_MODE:'enforce',FLURBO_SEMANTIC_RULES_JSON:JSON.stringify({schema:'flurbo.semantic-rules.v1',markets:[{pool,rulesHash:'0x'+'9'.repeat(64),predicates:[]}]})});
    const on=await request('/api/semantic-status','operator');
    assert.equal(on.data.mode,'enforced');assert.notEqual(on.data.configRevision,off.data.configRevision);
    assert.equal(on.data.markets[0].status,'misconfigured');assert.match(on.data.markets[0].error,/match/);
    // The misconfigured market stops new purchases instead of pretending to be unchecked or disabled.
    const blocked=await request('/api/pilot/validate-trade','member',claim);
    assert.equal(blocked.status,503);assert.equal(blocked.data.code,'SEMANTICS_UNAVAILABLE');
  }finally{loadSemanticConfig({});server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
