import assert from 'node:assert/strict';
import {test} from 'node:test';
import {privateKeyToAccount,generatePrivateKey} from 'viem/accounts';
import {walletLinks} from '../server/wallet-links.mjs';
import {agentWalletKey} from '../server/agents/agent-store.mjs';
import {alice,bob,origin,setup} from './agent-fixture.ts';

// A wallet is either an agent wallet or linked for manual MetaMask trading, never both: otherwise its trades
// would count in Portfolio and as agent performance. Both checks run when the challenge is issued and again
// when it is verified, and with Redis the two final writes exclude each other atomically. Runs on the fake,
// or on a real isolated Redis with FLURBO_TEST_REDIS_URL.
type Setup=ReturnType<typeof setup>;
const nonce=()=>Math.random().toString(36).slice(2);

// One server's view: the agent API and the wallet links, sharing its Redis command, as local-api.mjs wires them.
function server(s:Setup,command=s.redis.command){
  let api:any;
  const links=walletLinks({command,isReserved:(w:string)=>api.isAgentWallet(w),reservedKey:agentWalletKey});
  api=s.make({command,links});
  return {api,links};
}
async function runtimeAgent(s:Setup,which:any,login=alice){
  const r=await s.call(login,'POST','/api/agents',{kind:'runtime',name:'Exclusive',markets:['pilot']},which);
  assert.equal(r.status,200,JSON.stringify(r.body));return r.body.id as string;
}
const agentChallenge=async(s:Setup,which:any,id:string,wallet:any,login=alice)=>(await s.call(login,'POST',`/api/agents/${id}/wallet/challenge`,{wallet:wallet.address},which)).body;
const agentVerify=async(s:Setup,which:any,id:string,wallet:any,c:any,login=alice)=>s.call(login,'POST',`/api/agents/${id}/wallet/verify`,{id:c.id,signature:await wallet.signMessage({message:c.message})},which);
const linkChallenge=(links:any,wallet:any,login:string,session:string)=>links.challenge(login,wallet.address,origin,session);
const linkVerify=async(links:any,wallet:any,c:any,login:string,session:string)=>links.verify(login,c.id,await wallet.signMessage({message:c.message}),origin,session);

test('a wallet linked for manual trading after an agent challenge cannot then become the agent wallet',async()=>{
  const s=setup(),{api,links}=server(s),id=await runtimeAgent(s,api),wallet=privateKeyToAccount(generatePrivateKey()),session=nonce();
  const c=await agentChallenge(s,api,id,wallet);
  await linkVerify(links,wallet,await linkChallenge(links,wallet,bob,session),bob,session);  // linked by another account in between
  const r=await agentVerify(s,api,id,wallet,c);
  assert.equal(r.status,400);assert.match(r.body.error,/linked for manual MetaMask trading/);
  assert.equal(await api.isAgentWallet(wallet.address.toLowerCase()),false);
  assert.equal((await s.call(alice,'GET',`/api/agents/${id}`,undefined,api)).body.profile.wallet??null,null);
});

test('an agent wallet associated after a link challenge cannot then be linked for manual trading',async()=>{
  const s=setup(),{api,links}=server(s),id=await runtimeAgent(s,api),wallet=privateKeyToAccount(generatePrivateKey()),session=nonce();
  const link=await linkChallenge(links,wallet,alice,session);
  assert.equal((await agentVerify(s,api,id,wallet,await agentChallenge(s,api,id,wallet))).status,200);
  await assert.rejects(linkVerify(links,wallet,link,alice,session),/agent wallet/);
  assert.deepEqual((await links.list(alice,origin)).wallets,[]);
});

test('both final writes racing on separate servers: exactly one wins, decided atomically by Redis',async()=>{
  const s=setup();
  // Each server's final write (the agent wallet claim, the manual link) is held until both have passed every
  // earlier check, so only the atomic scripts can keep them apart.
  let arrived=0,release!:()=>void;const open=new Promise<void>(r=>{release=r;});
  const fallback=setTimeout(()=>release(),3000);  // never hang: a server without the second guarded write fails below
  const gated=async(op:string,...a:any[])=>{
    const final=op==='EVAL'&&(String(a[0]).includes('SISMEMBER')||String(a[0]).includes("EXISTS',KEYS[2]"));
    if(final){if(++arrived===2)release();await open;}
    return s.redis.command(op,...a);
  };
  const one=server(s,gated),two=server(s,gated),id=await runtimeAgent(s,one.api),wallet=privateKeyToAccount(generatePrivateKey()),session=nonce();
  const c=await agentChallenge(s,one.api,id,wallet),link=await linkChallenge(two.links,wallet,bob,session);
  const [agent,manual]=await Promise.allSettled([agentVerify(s,one.api,id,wallet,c),linkVerify(two.links,wallet,link,bob,session)]);
  const agentWon=agent.status==='fulfilled'&&(agent.value as any).status===200,linkWon=manual.status==='fulfilled';
  clearTimeout(fallback);
  assert.equal(arrived,2,'both reached their final write');
  assert.equal(Number(agentWon)+Number(linkWon),1,`agent ${agent.status} ${JSON.stringify((agent as any).value?.body)}, link ${manual.status}`);
  const agentKey=await s.redis.get(agentWalletKey(wallet.address.toLowerCase()));
  const linked=(await server(s).links.ownerOf(wallet.address,origin));
  assert.equal(Boolean(agentKey)&&Boolean(linked),false,'never both');
  assert.equal(Boolean(agentKey)||Boolean(linked),true,'one of them holds the wallet');
});

test('catalog operator addresses of the agent pools can never be agent wallets',async()=>{
  const {createServer,request}=await import('node:http');
  const {localApi}=await import('../server/local-api.mjs');
  const {poolFixture}=await import('./pool-fixture.ts');
  const f=poolFixture(),host='localhost:18767';
  const reserved=[f.manifest.pool,f.manifest.resolver,f.record.prepared.proposer,f.record.prepared.relay].map((a:string)=>a.toLowerCase());
  const api=localApi({store:{read:async(id:string)=>id==='alice'?{address:alice,method:'passkey'}:null},
    agentPools:{collections:[],services:new Map([[f.namespace,f.service]]),reservedAddresses:new Set(reserved)}} as any);
  const server=createServer((req,res)=>api(req,res,()=>{res.writeHead(404);res.end();}));
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',()=>r()));
  const call=(path:string,body:unknown):Promise<{status:number;data:any}>=>new Promise((resolve,reject)=>{
    const req=request({hostname:'127.0.0.1',port:(server.address() as any).port,path,method:'POST',headers:{host,origin:`http://${host}`,'content-type':'application/json',cookie:'flurbo_session=alice'}},res=>{
      let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode!,data:JSON.parse(text)}));});
    req.on('error',reject);req.end(JSON.stringify(body));
  });
  try{
    const created=await call('/api/agents',{kind:'runtime',name:'Reserved',markets:[f.namespace]});
    assert.equal(created.status,200,JSON.stringify(created.data));
    for(const wallet of reserved){
      const r=await call(`/api/agents/${created.data.id}/wallet/challenge`,{wallet});
      assert.equal(r.status,400,wallet);assert.match(r.data.error,/reserved for Flurbo operations/);
    }
    assert.equal((await call(`/api/agents/${created.data.id}/wallet/challenge`,{wallet:'0x'+'ef'.repeat(20)})).status,200);
  }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
