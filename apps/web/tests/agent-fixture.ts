import {decodeFunctionData,encodeFunctionResult,parseAbi} from 'viem';
import {agentApi} from '../server/agents/agent-api.mjs';
import {pilotFixture,owner} from './pilot-fixture.ts';
import {namespacedRedis} from './redis-resp.ts';

// Shared by agent API and browser tests: fake durable storage, an agent RPC over the pilot fixture with
// transaction mining, and a valid structured forecast. Not a test file.
export const alice='0x'+'ab'.repeat(20),bob='0x'+'cd'.repeat(20),origin='https://flurbo.singu.online',now=1_800_000_000;
export const multicall=parseAbi(['function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)']);

// Fake Upstash: the scripts the agent store sends, and nothing else.
export function fakeRedis(){
  const data=new Map<string,string>(),ttl=new Map<string,number>(),expires=new Map<string,number>(),sets=new Map<string,Set<string>>();
  const command=async(op:string,...a:any[])=>{
    // SET ... EX n expires on the real clock, as Redis does.
    for(const [key,at] of expires)if(at<=Date.now()){data.delete(key);expires.delete(key);}
    if(op==='GET')return data.get(a[0])??null;
    if(op==='SET'){if(a.includes('NX')&&data.has(a[0]))return null;data.set(a[0],a[1]);expires.delete(a[0]);const ex=a.indexOf('EX');if(ex>0){expires.set(a[0],Date.now()+Number(a[ex+1])*1000);ttl.set(a[0],Number(a[ex+1]));}return 'OK';}
    if(op==='DEL'){return data.delete(a[0])?1:0;}
    if(op==='GETDEL'){const v=data.get(a[0])??null;data.delete(a[0]);return v;}
    if(op==='EVAL'&&a[0].startsWith("local e=redis.call('GET',KEYS[1]) if e and e~=ARGV[1] then return 0 end")){const [,,key,value]=a;if(data.has(key)&&data.get(key)!==value)return 0;data.set(key,value);return 1;}
    if(op==='MGET')return a.map(key=>data.get(key)??null);
    if(op==='SMEMBERS')return [...(sets.get(a[0])??[])];
    // Wallet link verification (server/wallet-links.mjs): refused while the agent wallet key (KEYS[3]) exists.
    if(op==='EVAL'&&a[0].includes('SISMEMBER')){
      const n=Number(a[1]),[account,owner,reserved]=a.slice(2,2+n),[login,wallet]=a.slice(2+n);
      if(reserved&&data.has(reserved))return -3;
      if(data.has(owner)&&data.get(owner)!==login)return -1;
      const set=sets.get(account)??new Set<string>();if(!set.has(wallet)&&set.size>=20)return -2;
      data.set(owner,login);set.add(wallet);sets.set(account,set);return 1;
    }
    // Agent wallet claim refused while the manual link key (KEYS[2]) exists.
    if(op==='EVAL'&&a[0].includes("EXISTS',KEYS[2]")){const [,,key,blocker,value]=a;if(data.has(blocker))return -1;if(data.has(key)&&data.get(key)!==value)return 0;data.set(key,value);return 1;}
    if(op==='EVAL'&&a[0].includes('INCRBY')){const key=a[2],n=Number(data.get(key)??0)+Number(a[4]);data.set(key,String(n));ttl.set(key,Number(a[3]));return n;}
    if(op==='EVAL'&&a[0].includes('tonumber')){const [,,key,n]=a;if(Number(n)<=Number(data.get(key)??0))return 0;data.set(key,n);return 1;}
    if(op==='EVAL'&&a[0].includes('ARGV[3]')){
      // The agent state save script: revision check, ownership checks, then the writes.
      const n=Number(a[1]),keys=a.slice(2,2+n),argv=a.slice(2+n),[key,rev]=keys,owned=keys.slice(2).map((k:string,i:number)=>({k,value:argv[3+i]}));
      if((data.get(rev)??'0')!==argv[0])return 0;
      if(owned.some((c:any)=>data.has(c.k)&&data.get(c.k)!==c.value))return -1;
      for(const c of owned)if(!data.has(c.k))data.set(c.k,c.value);
      data.set(key,argv[1]);data.set(rev,argv[2]);return 1;
    }
    if(op==='EVAL'&&a[0].includes("redis.call('DEL'")){const [,,key,token]=a;if(data.get(key)===token){data.delete(key);return 1;}return 0;}
    if(op==='EVAL'&&a[0].includes('INCR')){const key=a[2],n=Number(data.get(key)??0)+1;data.set(key,String(n));if(n===1)ttl.set(key,Number(a[3]));return n;}
    if(op==='TTL')return data.has(a[0])?ttl.get(a[0])??-1:-2;
    if(op==='EXISTS')return data.has(a[0])?1:0;
    throw Error('Unexpected command '+op);
  };
  return {data,command};
}

// Agent tests run on the fake by default, and on a real isolated Redis when FLURBO_TEST_REDIS_URL is set
// (for example redis://127.0.0.1:6390/0). The helpers are the same either way.
export type TestRedis={real:boolean;command:(op:string,...a:any[])=>Promise<any>;keys():Promise<string[]>;get(k:string):Promise<string|null>;set(k:string,v:string):Promise<void>;del(k:string):Promise<void>};
export function agentRedis():TestRedis{
  if(process.env.FLURBO_TEST_REDIS_URL)return {real:true,...namespacedRedis(process.env.FLURBO_TEST_REDIS_URL)};
  const r=fakeRedis();
  return {real:false,command:r.command,keys:async()=>[...r.data.keys()],get:async k=>r.data.get(k)??null,set:async(k,v)=>{r.data.set(k,v);},del:async k=>{r.data.delete(k);}};
}

export function setup({links=[owner],at=now}:{links?:string[];at?:number}={}){
  const f=pilotFixture(at,3),redis=agentRedis(),txs=new Map<string,any>(),receipts=new Map<string,any>(),blocks=new Map<string,any>();
  // Agent RPC: multicall is expanded into the fixture's single reads; receipts come from a local table.
  const rpc=async(method:string,params:any[]=[])=>{
    if(method==='eth_call'&&params[0].to==='0xca11bde05977b3631167028862be2a173976ca11'){
      const calls=decodeFunctionData({abi:multicall,data:params[0].data}).args[0] as any[];
      const rows=[];
      for(const c of calls){try{rows.push({success:true,returnData:await f.rpc('eth_call',[{to:c.target,data:c.callData},params[1]])});}catch{rows.push({success:false,returnData:'0x'});}}
      return encodeFunctionResult({abi:multicall,functionName:'aggregate3',result:rows});
    }
    if(method==='eth_getTransactionByHash')return txs.get(params[0])??null;
    if(method==='eth_getTransactionReceipt')return receipts.get(params[0])??null;
    if(method==='eth_getBlockByNumber'&&params[0]==='latest')return {number:'0x70',hash:'0x'+'44'.repeat(32),timestamp:'0x'+at.toString(16)};
    if(method==='eth_getBlockByNumber'&&blocks.has(params[0]))return blocks.get(params[0]);
    if(method==='eth_getBlockByNumber'&&params[0]==='0x69')return {number:'0x69',hash:'0x'+'69'.repeat(32),timestamp:'0x'+at.toString(16)};
    if(method==='eth_getBalance')return '0xde0b6b3a7640000';
    return f.rpc(method,params);
  };
  let clock=at;
  // Linked MetaMask wallets: every account in these tests links the same list.
  const linked={list:async(account:string)=>({account,wallets:links.map(w=>w.toLowerCase())}),ownerOf:async(wallet:string)=>links.map(w=>w.toLowerCase()).includes(wallet.toLowerCase())?alice:null};
  const make=(overrides:Record<string,unknown>={})=>agentApi({command:redis.command,hosted:true,serviceFor:(ns:string)=>ns==='pilot'?f.service:null,links:linked,rpc,now:()=>clock,...overrides});
  const api=make();
  const call=async(login:string,method:string,path:string,input?:unknown,which=api)=>which.handle({method,path,input,login:{address:login,method:'passkey'},origin});
  // Mines a transaction. `block` and `timestamp` place it in its own block (below the head at 0x70).
  const mine=(tx:{from:string;to:string;data:string},hash:string,{status='0x1',logs=[] as any[],block='0x69',timestamp=null as number|null}={})=>{
    const blockHash=block==='0x69'?'0x'+'69'.repeat(32):'0x'+block.slice(2).padStart(2,'0').repeat(32).slice(0,64);
    if(block!=='0x69')blocks.set(block,{number:block,hash:blockHash,timestamp:'0x'+(timestamp??clock).toString(16)});
    txs.set(hash,{hash,chainId:'0x279f',from:tx.from,to:tx.to,input:tx.data,value:'0x0',blockHash,blockNumber:block});
    receipts.set(hash,{transactionHash:hash,blockHash,blockNumber:block,status,logs,gasUsed:'0x5208',effectiveGasPrice:'0x3b9aca00'});
  };
  const seen=(tx:{from:string;to:string;data:string},hash:string)=>{txs.set(hash,{hash,chainId:'0x279f',from:tx.from,to:tx.to,input:tx.data,value:'0x0',blockHash:null,blockNumber:null});};
  return {f,redis,api,make,call,rpc,mine,seen,txs,advance:(s:number)=>{clock+=s;},clock:()=>clock};
}
export const forecast=(pool:string,over:Record<string,unknown>={},at=now)=>({schema:'flurbo.agent-forecast.v1',pool,joint:{events:[0,1],statesPpm:['300000','100000','150000','450000']},
  evidence:[{id:'e1',title:'Release candidate tagged',source:'Project release page',url:'https://github.com/ethereum/go-ethereum/releases',observedAt:new Date((at-3600)*1000).toISOString(),note:'Illustrative test note.'}],
  assumptions:['Both releases share a dependency.'],uncertainty:'Test forecast only.',explanation:'The two releases usually ship together, so the joint outcome is more likely than independence suggests.',
  selfReportedConfidence:'medium',source:{kind:'provider',name:'claims-to-be-a-provider'},createdAt:new Date((at-60)*1000).toISOString(),...over});

