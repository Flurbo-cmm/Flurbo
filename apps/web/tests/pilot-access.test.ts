import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeFunctionData, parseTransaction } from 'viem';
import { TESTNET } from '../server/network.mjs';
import { poolFixture, hash, owner, pool } from './pool-fixture.ts';
import { pilotCashAbi } from '../shared/pilot.mjs';
import { pilotMera, checkPilotPending, pendingKeyFor, readPilotPending, pilotRequest } from '../src/pilot.ts';
import { AuthController } from '../src/auth/controller.ts';
import { authPolicy } from '../src/auth/policy.ts';

test('pending confirmations and response manifests are bound to the agent pool namespace',async()=>{
  const f=poolFixture();f.options.allowance=1000000n;
  const review=await f.service.prepare({owner,action:'buy',scope:3,mask:'8',quantity:'1000000',slippageBps:50});
  const saved={review,nonce:'0x79' as const,hash,started:Date.now(),login:owner},namespace=f.namespace as `practice-${string}`;
  const db=new Map<string,string>(),descriptor=Object.getOwnPropertyDescriptor(globalThis,'localStorage'),fetch=globalThis.fetch;
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:(key:string)=>db.get(key)??null}});
  try{
    assert.equal(readPilotPending(namespace),null);
    db.set(pendingKeyFor(namespace),JSON.stringify(saved));assert.equal(readPilotPending(namespace)?.hash,hash);
    const wrong=('practice-'+'ab'.repeat(20)) as `practice-${string}`;db.set(pendingKeyFor(wrong),JSON.stringify(saved));
    assert.throws(()=>readPilotPending(wrong),/different market/);await assert.rejects(checkPilotPending(saved,wrong));
    db.set(pendingKeyFor('pilot'),JSON.stringify(saved));assert.throws(()=>readPilotPending('pilot'),/different market/);
    globalThis.fetch=async(url:any)=>{assert.ok(String(url).startsWith('/api/'+namespace+'/'));return Response.json({manifest:review.manifest});};
    assert.equal((await pilotRequest<any>('markets',undefined,namespace)).manifest.pool,f.manifest.pool);
    globalThis.fetch=async()=>Response.json({manifest:f.manifest});await assert.rejects(pilotRequest('markets',undefined,wrong),/different collection/);
    globalThis.fetch=async(url:any)=>{assert.equal(String(url),'/api/'+namespace+'/rpc');return Response.json({result:null});};
    assert.equal(await checkPilotPending(saved),'pending');
  }finally{globalThis.fetch=fetch;if(descriptor)Object.defineProperty(globalThis,'localStorage',descriptor);else delete (globalThis as any).localStorage;}
});

test('the Mera adapter for an agent pool refuses all transaction signing, including previously supported calls',async()=>{
  const controller=new AuthController({policy:authPolicy('http://localhost:18767',true,true,true),client:{async createCredential(){throw Error('unused');},async getCredential(){return{credentialId:new Uint8Array([1]),prfOutput:new Uint8Array(32).fill(9)};}}});
  const f=poolFixture(),provider=pilotMera(controller,f.namespace as `practice-${string}`),original=globalThis.fetch;let writes=0;
  globalThis.fetch=async(_input,options)=>{
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

test('agent pool tracking rejects mismatched chain, receipt identity and call, and requires canonical confirmations',async()=>{
  const f=poolFixture();f.options.allowance=1000000n;
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
