import assert from 'node:assert/strict';
import { test } from 'node:test';
import { request as httpRequest } from 'node:http';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { SessionStore } from '../server/session.mjs';
import { RedisSessionStore, redisCommand } from '../server/redis-session.mjs';
import { hostedConfig, TESTNET } from '../server/network.mjs';
import { productionServer } from '../server/production.mjs';
import { androidAssetLinks } from '../server/native-association.mjs';

const signer = privateKeyToAccount(('0x' + '11'.repeat(32)) as `0x${string}`);
const origin = 'https://flurbo.singu.online';
function memoryRedis() {
  const data = new Map<string,string>();
  const command = async (...args: Array<string | number>) => {
    const [cmd,key,value] = args as string[];
    if(cmd === 'EVAL') return 1;
    if(cmd === 'SET') { data.set(key,value); assert.ok(Number(args[4]) > 0); return 'OK'; }
    const result = data.get(key) || null;
    if(cmd === 'GETDEL' || cmd === 'DEL') data.delete(key);
    return result;
  };
  return {data,command};
}
test('durable session adapter survives service reconstruction, consumes proofs once and revokes everywhere', async () => {
  let now = Date.now(); const redis = memoryRedis();
  const first = new RedisSessionStore(redis.command,()=>now), restarted = new RedisSessionStore(redis.command,()=>now);
  const challenge = await first.challenge(signer.address,origin,'passkey');
  const signature = await signer.signMessage({message:challenge.message});
  const attempts = await Promise.allSettled([first.verify(challenge.id,signature,origin),restarted.verify(challenge.id,signature,origin)]);
  assert.equal(attempts.filter(a=>a.status==='fulfilled').length,1);
  const login = (attempts.find(a=>a.status==='fulfilled') as PromiseFulfilledResult<any>).value;
  assert.equal((await restarted.read(login.sessionId,origin)).method,'passkey');
  assert.equal(await restarted.read(login.sessionId,'https://other.example'),null);
  assert.ok(![...redis.data.keys()].some(k=>k.includes(login.sessionId)));
  await restarted.revoke(login.sessionId); assert.equal(await first.read(login.sessionId,origin),null);
  const stale = await first.challenge(signer.address,origin); now += 300001;
  await assert.rejects(restarted.verify(stale.id,await signer.signMessage({message:stale.message}),origin));
});
test('host configuration rejects local/mainnet RPC and session storage never falls back to memory', async () => {
  const env = {FLURBO_ORIGIN:origin,FLURBO_NETWORK:'public_testnet'};
  assert.equal(hostedConfig(env).rpcUrl,TESTNET.rpc + '/');
  for(const url of ['http://127.0.0.1:18545','https://rpc.monad.xyz','https://evil.example']) assert.throws(()=>hostedConfig({...env,FLURBO_ALCHEMY_TESTNET_RPC_URL:url}));
  assert.throws(()=>hostedConfig({...env,FLURBO_NETWORK:'mainnet'}));
  assert.throws(()=>redisCommand({}));
  const command = redisCommand({UPSTASH_REDIS_REST_URL:'https://fixture.upstash.io',UPSTASH_REDIS_REST_TOKEN:'fixture'}, async () => Response.json({error:'denied'}));
  await assert.rejects(command('GET','key'));
});
test('hosted HTTP serves guarded SPA routes, secure login and MetaMask-only submission policy without local funding', async () => {
  const directory = await mkdtemp(join(tmpdir(),'flurbo-server-'));
  await writeFile(join(directory,'index.html'),'<html>Flurbo</html>');
  await mkdir(join(directory,'brand'));
  await writeFile(join(directory,'brand','flurbo-social-landscape.png'),'landscape');
  await writeFile(join(directory,'brand','flurbo-social-portrait.png'),'portrait');
  await writeFile(join(directory,'brand','flurbo-social-banner.png'),'banner');
  await writeFile(join(directory,'brand','flurbo-social-banner-v2.png'),'banner-v2');
  await writeFile(join(directory,'brand','flurbo-profile-2026.png'),'profile');
  await writeFile(join(directory,'favicon-contour.svg'),'<svg/>');
  await writeFile(join(directory,'technical_litepaper.pdf'),'%PDF-fixture');
  await writeFile(join(directory,'robots.txt'),'User-agent: *\nDisallow: /markets\n');
  const store = new SessionStore();
  const learningReport = {schema:'flurbo.learning-comparison.v1',input:'synthetic',changesExecutablePrices:false};
  const config = {previewAccess:null,testingOperatorAccount:signer.address.toLowerCase(),origin,rpcUrl:TESTNET.rpc,learningReport: learningReport as typeof learningReport | null, learningStatus: 'starting', androidAssetLinks: null as object[] | null};
  const server = productionServer(config,store,directory);
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port = (server.address() as {port:number}).port;
  function request(path:string,body?:object,cookie='',host='flurbo.singu.online',requestOrigin=origin,method=body?'POST':'GET'):Promise<any> {
    return new Promise((resolve,reject)=>{
      const req=httpRequest({hostname:'127.0.0.1',port,path,method,headers:{Host:host,Origin:requestOrigin,'Content-Type':'application/json',Cookie:cookie}},res=>{
        let text='';res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text,json:()=>JSON.parse(text)}));
      });req.on('error',reject);req.end(body?JSON.stringify(body):undefined);
    });
  }
  const originalFetch=globalThis.fetch;let broadcasts=0, environment='public_testnet';
  const pool='0x'+'22'.repeat(20);
  globalThis.fetch=async(input,options)=>{
    if(String(input)==='http://127.0.0.1:18765/api/state') return Response.json({environment,chain_id:10143,contracts:{pool,cash:TESTNET.cash}});
    if(String(input)===TESTNET.rpc) { const body=JSON.parse(options!.body as string); if(body.method==='eth_sendRawTransaction') broadcasts++; return Response.json({result:'0x'+'77'.repeat(32)}); }
    throw Error('Unexpected upstream');
  };
  try {
    assert.equal((await request('/envio', {kind:'trades',pool,limit:5})).status,503);
    assert.equal((await request('/envio')).status,405);
    assert.equal((await request('/.well-known/assetlinks.json')).status,404);
    config.androidAssetLinks = androidAssetLinks({FLURBO_ANDROID_CERT_SHA256:Array(32).fill('AB').join(':')});
    const association = await request('/.well-known/assetlinks.json',undefined,'','flurbo.singu.online','');
    assert.equal(association.status,200); assert.deepEqual(association.json(),config.androidAssetLinks);
    assert.ok(association.json()[0].relation.includes('delegate_permission/common.handle_all_urls'));
    assert.ok(association.json()[0].relation.includes('delegate_permission/common.get_login_creds'));
    assert.equal(association.headers['content-type'],'application/json'); assert.equal(association.headers.location,undefined);
    assert.equal((await request('/.well-known/assetlinks.json',undefined,'','evil.example')).status,421);
    assert.equal((await request('/.well-known/assetlinks.json',{})).status,405);
    assert.equal((await request('/account')).status,404); // Client route waits for verified auth.
    assert.equal((await request('/portfolio')).status,200);
    assert.equal((await request('/history')).status,200);
    // Direct visits and refreshes must serve the same shell as client-side navigation.
    // Agent data remains protected by the API's passkey and invite checks.
    const agentPath='/agents/12345678-1234-4234-8234-123456789abc';
    for(const path of ['/agents',agentPath,agentPath+'?view=activity','/markets/pilot/0/thesis','/markets/practice-'+ '22'.repeat(20)+'/2/thesis']) {
      for(const method of ['GET','HEAD']) {
        const page=await request(path,undefined,'','flurbo.singu.online','',method);
        assert.equal(page.status,200,method+' '+path);
        assert.equal(page.headers['content-type'],'text/html; charset=utf-8');
        assert.equal(page.headers['cache-control'],'no-store');
        assert.match(page.headers['content-security-policy'],/script-src 'self'/);
        assert.equal(page.text,method==='HEAD'?'':'<html>Flurbo</html>');
      }
    }
    for(const path of ['/agents/not-an-id',agentPath+'/extra','/agents/.env'])
      assert.equal((await request(path)).status,404,path);
    assert.equal((await request('/agents',{})).status,405);
    assert.equal((await request('/api/agents')).status,401);
    assert.equal((await request('/rehearsal')).status,404);
    assert.equal((await request('/markets')).status,200);
    const docs = await request('/docs',undefined,'','flurbo.singu.online','');
    assert.equal(docs.status,200);
    assert.match(docs.headers['content-security-policy'],/script-src 'self'/);
    assert.equal(docs.headers['cache-control'],'no-store');
    // The retired September practice alias no longer serves a page.
    assert.equal((await request('/markets/rehearsal/1')).status,404);
    assert.equal((await request('/markets/rehearsal/1/thesis')).status,404);
    assert.equal((await request('/markets/practice-'+'12'.repeat(20)+'/0')).status,200);
    assert.equal((await request('/markets/unknown/99')).status,404);
    assert.equal((await request('/rehearsal-rules')).json().fixtures.length,4);
    assert.equal((await request('/rehearsal-rules')).json().fixtures[1].result,'NO');
    assert.equal((await request('/.env')).status,404);
    for(const path of ['/brand/flurbo-social-landscape.png','/brand/flurbo-social-portrait.png','/brand/flurbo-social-banner.png','/brand/flurbo-social-banner-v2.png','/brand/flurbo-profile-2026.png']) {
      const asset=await request(path);
      assert.equal(asset.status,200,path);
      assert.equal(asset.headers['content-type'],'image/png');
      assert.equal(asset.headers['cache-control'],'public, max-age=31536000, immutable');
    }
    const favicon=await request('/favicon-contour.svg');
    assert.equal(favicon.status,200);
    assert.equal(favicon.headers['content-type'],'image/svg+xml');
    for(const method of ['GET','HEAD']) {
      const litepaper=await request('/technical_litepaper.pdf',undefined,'','flurbo.singu.online','',method);
      assert.equal(litepaper.status,200);
      assert.equal(litepaper.headers['content-type'],'application/pdf');
      assert.equal(litepaper.headers['cache-control'],'public, max-age=3600');
      assert.equal(litepaper.text,method==='HEAD'?'':'%PDF-fixture');
    }
    // Unknown page-like paths keep a 404 status but show the Flurbo shell; assets stay plain.
    for(const path of ['/does-not-exist','/markets/unknown/99','/agents/not-an-id','/rehearsal']) {
      const missing=await request(path);
      assert.equal(missing.status,404,path);
      assert.equal(missing.headers['content-type'],'text/html; charset=utf-8',path);
      assert.equal(missing.headers['cache-control'],'no-store',path);
      assert.equal(missing.text,'<html>Flurbo</html>',path);
    }
    for(const path of ['/assets/missing.js','/brand/not-public.png','/.env','/technical_litepaper.pdf.exe']) {
      const missing=await request(path);
      assert.equal(missing.status,404,path);
      assert.equal(missing.text,'Not found',path);
    }
    const robots=await request('/robots.txt');
    assert.equal(robots.status,200);
    assert.equal(robots.headers['content-type'],'text/plain');
    assert.equal(robots.headers['cache-control'],'public, max-age=3600');
    assert.match(robots.text,/Disallow: \/markets/);
    assert.equal((await request('/technical_litepaper.pdf.exe')).status,404);
    assert.equal((await request('/brand/not-public.png')).status,404);
    assert.equal((await request('/brand/../index.html')).status,404);
    assert.equal((await request('/api/network',undefined,'','evil.example')).status,421);
    assert.equal((await request('/api/auth/challenge',{address:signer.address},'','flurbo.singu.online','https://evil.example')).status,403);
    assert.equal((await request('/api/local-wallet-setup',{wallet:signer.address})).status,404);
    assert.equal((await request('/api/rpc',{method:'anvil_setBalance',params:[]})).status,400);
    assert.equal((await request('/api/learning/comparison')).status,401);
    assert.equal((await request('/healthz')).json().learning_comparison,'ready');
    assert.equal((await request('/healthz')).json().pilot_pool,'disabled');
    assert.equal((await request('/healthz')).json().rehearsal_pool,undefined);
    // The in-process settlement bot is opt-in; hosting without FLURBO_SETTLEMENT_BOT reports it disabled.
    assert.equal((await request('/healthz')).json().settlement_bot,'disabled');
    const ns='practice-'+pool.slice(2),rulesHash='0x'+'44'.repeat(32);
    (config as any).practiceCollections={catalog:{active:ns},services:new Map([[ns,{manifest:{pool,rulesHash,publication:{draft:{closesAt:1800000000}}},secret:'must-not-leak'}]])};
    const health=(await request('/healthz')).json();
    assert.equal(health.chain_state,'not_checked');
    assert.deepEqual(health.practice_collections,{active:ns,configured:[{namespace:ns,pool,rulesHash,closesAt:1800000000}]});
    assert.ok(!JSON.stringify(health).includes('must-not-leak'));
    delete (config as any).practiceCollections;

    assert.equal((await request('/api/auth/challenge',{address:signer.address,method:'wallet'})).status,400);
    const challenge=await request('/api/auth/challenge',{address:signer.address,method:'passkey'});
    const verified=await request('/api/auth/verify',{signature:await signer.signMessage({message:challenge.json().message})},challenge.headers['set-cookie'][0].split(';')[0]);
    assert.equal(verified.status,200);assert.match(verified.headers['set-cookie'][0],/HttpOnly.*SameSite=Strict.*Secure/);
    const cookie=verified.headers['set-cookie'][0].split(';')[0];
    assert.deepEqual((await request('/api/learning/comparison',undefined,cookie)).json(),learningReport);
    config.learningReport = null;
    assert.equal((await request('/api/learning/comparison',undefined,cookie)).status,503);
    assert.equal((await request('/healthz')).json().learning_comparison,'starting');
    assert.equal((await request('/account')).status,404);
    config.learningReport = learningReport;
    assert.equal((await request('/api/learning/comparison?command=replay',undefined,cookie)).status,400);
    assert.equal((await request('/api/learning/comparison',{command:'replay'},cookie)).status,405);
    assert.equal((await request('/api/learning/comparison',undefined,cookie,'flurbo.singu.online','https://evil.example')).status,403);
    assert.equal((await request('/api/auth/session',undefined,cookie)).json().session.method,'passkey');
    const tx={type:'legacy' as const,chainId:10143,nonce:0,gas:100000n,gasPrice:1000000000n,to:TESTNET.cash as `0x${string}`,value:0n,data:('0x095ea7b3'+pool.slice(2).padStart(64,'0')+'1'.padStart(64,'0')) as `0x${string}`};
    const send=async(value:typeof tx)=>request('/api/rpc',{method:'eth_sendRawTransaction',params:[await signer.signTransaction(value)]},cookie);
    assert.equal((await send(tx)).status,403);
    const withdrawal={...tx,data:('0xa9059cbb'+'44'.repeat(20).padStart(64,'0')+'1'.padStart(64,'0')) as `0x${string}`};
    assert.equal((await send(withdrawal)).status,403);
    for(const recipient of ['00'.repeat(20),pool.slice(2),TESTNET.cash.slice(2),signer.address.slice(2).toLowerCase()]) {
      assert.equal((await send({...withdrawal,data:('0xa9059cbb'+recipient.padStart(64,'0')+'1'.padStart(64,'0')) as `0x${string}`})).status,403);
    }
    assert.equal((await send({...withdrawal,data:(withdrawal.data.slice(0,74)+'0'.repeat(64)) as `0x${string}`})).status,403);
    assert.equal((await send({...withdrawal,data:('0x23b872dd'+withdrawal.data.slice(10)) as `0x${string}`})).status,403);
    assert.equal((await send({...tx,chainId:143})).status,403);
    assert.equal((await send({...tx,value:1n})).status,403);
    assert.equal((await send({...tx,data:('0x095ea7b3'+'33'.repeat(20).padStart(64,'0')+'1'.padStart(64,'0')) as `0x${string}`})).status,403);
    environment='local_fork'; assert.equal((await send(tx)).status,403);
    const faucet={...tx,to:TESTNET.faucet as `0x${string}`,data:(TESTNET.faucetSelector+signer.address.slice(2).toLowerCase().padStart(64,'0')) as `0x${string}`};
    assert.equal((await send(faucet)).status,403);
    assert.equal((await send({...faucet,value:1n})).status,403);
    assert.equal((await send({...faucet,data:(TESTNET.faucetSelector+'33'.repeat(20).padStart(64,'0')) as `0x${string}`})).status,403);
    assert.equal(broadcasts,0);
    assert.equal((await request('/api/state')).status,503);
    await request('/api/auth/logout',{},cookie); assert.equal((await request('/api/auth/session',undefined,cookie)).json().session,null);
    assert.equal((await request('/api/learning/comparison',undefined,cookie)).status,401);
  } finally { globalThis.fetch=originalFetch;server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));assert.equal(dirname(directory),tmpdir());assert.ok(basename(directory).startsWith('flurbo-server-'));await rm(directory,{recursive:true,force:true}); }
});
