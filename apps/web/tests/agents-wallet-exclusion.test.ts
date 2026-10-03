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
