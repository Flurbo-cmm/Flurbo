import assert from 'node:assert/strict';
import { test } from 'node:test';
import { request as httpRequest } from 'node:http';
import { privateKeyToAccount } from 'viem/accounts';
import { encodeFunctionData, parseTransaction } from 'viem';
import { productionServer } from '../server/production.mjs';
import { TESTNET } from '../server/network.mjs';
import { pilotFixture, hash, owner, pool } from './pilot-fixture.ts';
import { pilotCashAbi } from '../shared/pilot.mjs';
import { pilotMera, checkPilotPending } from '../src/pilot.ts';
import { AuthController } from '../src/auth/controller.ts';
import { authPolicy } from '../src/auth/policy.ts';

test('pilot endpoints require Mera login; public evidence remains readable; raw submission is disabled',async()=>{
  const signer=privateKeyToAccount(('0x'+'11'.repeat(32)) as `0x${string}`),f=pilotFixture(),origin='https://flurbo.singu.online';
  const store={read:async(id:string)=>id==='fixture'?{address:signer.address.toLowerCase(),method:'passkey'}:null};
  const server=productionServer({previewAccess:null, origin,rpcUrl:TESTNET.rpc,pilot:f.service,pilotEvidence:{get:async()=>'{"public":true}'}},store);
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=(server.address() as {port:number}).port,original=globalThis.fetch;let writes=0;
  globalThis.fetch=async()=>{writes++;return Response.json({result:hash});};
  const request=(path:string,body?:unknown,login=true,requestOrigin=origin):Promise<number>=>new Promise((resolve,reject)=>{
    const req=httpRequest({hostname:'127.0.0.1',port,path,method:body?'POST':'GET',headers:{Host:'flurbo.singu.online',Origin:requestOrigin,Cookie:login?'flurbo_session=fixture':'','Content-Type':'application/json'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode!));});
    req.on('error',reject);req.end(body?JSON.stringify(body):undefined);
  });
  const signed=async(chainId=10143,to=TESTNET.cash,account=signer)=>account.signTransaction({type:'legacy',chainId,nonce:0,to:to as `0x${string}`,data:encodeFunctionData({abi:pilotCashAbi,functionName:'approve',args:[pool,1000000n]}),value:0n,gas:100000n,gasPrice:1000000000n});
  const submit=async(raw:string)=>request('/api/pilot/rpc',{method:'eth_sendRawTransaction',params:[raw]});
  try{
    assert.equal(await request('/api/pilot/status',undefined,false),401);
    assert.equal(await request('/api/pilot/markets',undefined,false),401);
    assert.equal(await request('/api/pilot/price-history',undefined,false),401);
    assert.equal(await request('/api/pilot/price-history'),503); // no durable archive configured
    assert.equal(await request('/api/pilot/price-history?wallet='+owner),400);
    assert.equal(await request('/api/pilot/markets'),200);
    assert.equal(await request('/api/pilot/account?wallet='+owner,undefined,false),401);
    assert.equal(await request('/api/pilot/account?wallet='+owner),200);
    assert.equal(await request('/api/pilot/account?wallet='+owner+'&wallet='+owner),400);
    assert.equal(await request('/api/pilot/prepare',{owner,action:'deliver'},false),401);
    assert.equal(await request('/api/pilot/status'),200);
    assert.equal(await request('/api/pilot/evidence/'+hash,undefined,false),200);
    assert.equal(await request('/api/pilot/prepare',{owner,action:'deliver'},true,'https://evil.example'),403);
    assert.equal(await submit(await signed()),403);
    assert.equal(await submit(await signed(143)),403);
    assert.equal(await submit(await signed(10143,pool)),403);
    assert.equal(await submit(await signed(10143,TESTNET.cash,privateKeyToAccount(('0x'+'22'.repeat(32)) as `0x${string}`))),403);
    assert.equal(writes,0);
  }finally{globalThis.fetch=original;await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('practice collection API is authenticated, cannot sign for another pool, and the retired alias is gone',async()=>{
  const signer=privateKeyToAccount(('0x'+'11'.repeat(32)) as `0x${string}`),f=pilotFixture(),origin='https://flurbo.singu.online';
  const rehearsalPool=('0x'+'aa'.repeat(20)) as `0x${string}`;
  const manifest={...f.manifest,pool:rehearsalPool,publication:{...f.manifest.publication,mode:'rehearsal'}};
  const rehearsal={manifest,snapshot:async()=>({}),status:async()=>({pool:rehearsalPool})};
  const store={read:async(id:string)=>id==='fixture'?{address:signer.address.toLowerCase(),method:'passkey'}:null};
  const namespace='practice-'+'bb'.repeat(20), archivedPool=('0x'+'bb'.repeat(20)) as `0x${string}`;
  const archived={...rehearsal,manifest:{...manifest,pool:archivedPool},status:async()=>({pool:archivedPool})};
  const practiceCollections={services:new Map([[namespace,archived]]),catalog:{active:namespace}};
  const server=productionServer({previewAccess:null, origin,rpcUrl:TESTNET.rpc,pilot:f.service,practiceCollections},store);
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=(server.address() as {port:number}).port,original=globalThis.fetch;let writes=0;
  globalThis.fetch=async()=>{writes++;return Response.json({result:hash});};
  const request=(path:string,body?:unknown,login=true):Promise<number>=>new Promise((resolve,reject)=>{
    const req=httpRequest({hostname:'127.0.0.1',port,path,method:body?'POST':'GET',headers:{Host:'flurbo.singu.online',Origin:origin,Cookie:login?'flurbo_session=fixture':'','Content-Type':'application/json'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode!));});req.on('error',reject);req.end(body?JSON.stringify(body):undefined);
  });
  const raw=async(spender:`0x${string}`)=>signer.signTransaction({type:'legacy',chainId:10143,nonce:0,to:TESTNET.cash as `0x${string}`,data:encodeFunctionData({abi:pilotCashAbi,functionName:'approve',args:[spender,1000000n]}),value:0n,gas:100000n,gasPrice:1000000000n});
  try{
    assert.equal(await request('/api/rehearsal/status'),404);
    assert.equal(await request('/api/rehearsal/rpc',{method:'eth_sendRawTransaction',params:[await raw(rehearsalPool)]}),404);
    assert.equal(await request('/api/pilot/rpc',{method:'eth_sendRawTransaction',params:[await raw(rehearsalPool)]}),403);
    assert.equal(await request('/api/'+namespace+'/rpc',{method:'eth_sendRawTransaction',params:[await raw(pool)]}),403);
    assert.equal(await request('/api/practice-collections',undefined,false),401);
    assert.equal(await request('/api/practice-collections'),200);
    assert.equal(await request('/api/'+namespace+'/status',undefined,false),401);
    assert.equal(await request('/api/'+namespace+'/status'),200);
    assert.equal(await request('/api/practice-'+'cc'.repeat(20)+'/status'),404);
    assert.equal(await request('/api/'+namespace+'/rpc',{method:'eth_sendRawTransaction',params:[await raw(rehearsalPool)]}),403);
    assert.equal(await request('/api/'+namespace+'/rpc',{method:'eth_sendRawTransaction',params:[await raw(archivedPool)]}),403);
    assert.equal(writes,0);
  }finally{globalThis.fetch=original;await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('pilot Mera adapter refuses all transaction signing, including previously supported calls',async()=>{
  const controller=new AuthController({policy:authPolicy('http://localhost:18767',true,true,true),client:{async createCredential(){throw Error('unused');},async getCredential(){return{credentialId:new Uint8Array([1]),prfOutput:new Uint8Array(32).fill(9)};}}});
  const f=pilotFixture(),provider=pilotMera(controller),original=globalThis.fetch;let writes=0;
  globalThis.fetch=async(input,options)=>{
    if(input==='/api/pilot/status')return Response.json(await f.service.status());
    const r=JSON.parse(options!.body as string);
    if(r.method==='eth_sendRawTransaction'){const tx=parseTransaction(r.params[0]);assert.equal(tx.chainId,10143);assert.equal(tx.nonce,121);writes++;return Response.json({result:hash});}
    return Response.json({result:r.method==='eth_getTransactionCount'?121:undefined});
  };
  try{
    await controller.authenticate('login');const from=controller.getSnapshot().address!;
    const tx={from,to:TESTNET.cash,data:encodeFunctionData({abi:pilotCashAbi,functionName:'approve',args:[pool,1000000n]}),chainId:'0x279f',value:'0x0',nonce:'0x79',gas:'0x186a0',gasPrice:'0x3b9aca00'};
    const send=(changes={})=>provider.request({method:'eth_sendTransaction',params:[{...tx,...changes}]});
    await assert.rejects(send(),/account access only/);await assert.rejects(send({from:owner}));await assert.rejects(send({nonce:'0x78'}));await assert.rejects(send({to:pool}));
    controller.lockSigning();await assert.rejects(send(),/account access only/);assert.equal(writes,0);
  }finally{globalThis.fetch=original;await controller.signOut();}
});

test('pilot tracking rejects mismatched chain, receipt identity and call, and requires canonical confirmations',async()=>{
  const f=pilotFixture();f.options.allowance=1000000n;
  const review=await f.service.prepare({owner,action:'buy',scope:3,mask:'8',quantity:'1000000',slippageBps:50});
  const saved={review,nonce:'0x79' as const,hash,started:Date.now(),login:owner};
  const original=globalThis.fetch;
  const tx:any={...review.transaction,hash,chainId:'0x279f',blockNumber:'0x64',blockHash:hash,input:review.transaction.data,nonce:'0x79'};
  const receipt:any={transactionHash:hash,blockNumber:'0x64',blockHash:hash,status:'0x1'};let head='0x65';
  globalThis.fetch=async(_input,options)=>{const r=JSON.parse(options!.body as string);return Response.json({result:r.method==='eth_getTransactionByHash'?tx:r.method==='eth_getTransactionReceipt'?receipt:{hash,number:head}});};
  try{
    assert.equal(await checkPilotPending(saved),'confirmed');head='0x64';assert.equal(await checkPilotPending(saved),'confirming');head='0x65';
    tx.chainId='0x8f';await assert.rejects(checkPilotPending(saved));tx.chainId='0x279f';
    receipt.transactionHash='0x'+'aa'.repeat(32);await assert.rejects(checkPilotPending(saved));receipt.transactionHash=hash;
    tx.input+='00';await assert.rejects(checkPilotPending(saved));tx.input=review.transaction.data;
    receipt.status='0x0';assert.equal(await checkPilotPending(saved),'reverted');
  }finally{globalThis.fetch=original;}
});
