import {test} from 'node:test';
import assert from 'node:assert/strict';
import {privateKeyToAccount} from 'viem/accounts';
import {walletLinks} from '../server/wallet-links.mjs';
import {createServer} from 'node:http';
import {localApi} from '../server/local-api.mjs';
const signer=privateKeyToAccount('0x'+'12'.repeat(32) as `0x${string}`),other=privateKeyToAccount('0x'+'13'.repeat(32) as `0x${string}`);
const account='0x'+'99'.repeat(20),origin='https://flurbo.singu.online';
test('wallet links require ownership, bind session/account/origin, expire and cannot replay',async()=>{
  let now=1000000;const links=walletLinks({now:()=>now});
  const make=()=>links.challenge(account,signer.address,origin,'session');
  assert.deepEqual((await links.list(account,origin)).wallets,[]);
  let proof=await make();await assert.rejects(links.verify(account,proof.id,await other.signMessage({message:proof.message}),origin,'session'));
  for(const [login,site,session] of [[other.address,origin,'session'],[account,'https://other.example','session'],[account,origin,'other-session']]){
    proof=await make();await assert.rejects(links.verify(login,proof.id,await signer.signMessage({message:proof.message}),site,session));
  }
  proof=await make();now+=300001;await assert.rejects(links.verify(account,proof.id,await signer.signMessage({message:proof.message}),origin,'session'));
  proof=await make();const signature=await signer.signMessage({message:proof.message});
  await links.verify(account,proof.id,signature,origin,'session');
  assert.deepEqual((await links.list(account,origin)).wallets,[signer.address.toLowerCase()]);
  await assert.rejects(links.verify(account,proof.id,signature,origin,'session'));
  proof=await links.challenge(other.address,signer.address,origin,'session2');
  await assert.rejects(links.verify(other.address,proof.id,await signer.signMessage({message:proof.message}),origin,'session2'),/another Flurbo account/);
  await assert.rejects(links.challenge(account,account,origin,'session'));
});

// Exercises the durable command protocol and reconstruction across service instances.
test('durable links survive a new server instance and combine wallets without overwriting',async()=>{
  const values=new Map<string,any>(),sets=new Map<string,Set<string>>();
  const command=async(op:string,...args:any[])=>{
    if(op==='SET'){values.set(args[0],args[1]);return 'OK';}
    if(op==='GETDEL'){const v=values.get(args[0]);values.delete(args[0]);return v??null;}
    if(op==='SMEMBERS')return [...(sets.get(args[0])||[])];
    if(op==='EVAL'){
      if(args[1]===1)return 1;
      const [, ,accountKey,ownerKey,login,wallet]=args,previous=values.get(ownerKey),set=sets.get(accountKey)||new Set<string>();
      if(previous&&previous!==login)return -1;
      if(!set.has(wallet)&&set.size>=20)return -2;
      values.set(ownerKey,login);set.add(wallet);sets.set(accountKey,set);return 1;
    }
    throw Error(op);
  };
  for(const wallet of [signer,other]){
    const links=walletLinks({command}),proof=await links.challenge(account,wallet.address,origin,'session');
    await walletLinks({command}).verify(account,proof.id,await wallet.signMessage({message:proof.message}),origin,'session');
  }
  assert.equal((await walletLinks({command}).list(account,origin)).wallets.length,2);
  assert.deepEqual((await walletLinks({command}).list(other.address,origin)).wallets,[]);
});

test('wallet API requires the Mera session, rejects cross-origin writes, and lists the verified link',async()=>{
  const hosts:string[]=[];
  const api=localApi({hosts,store:{read:async(id:string)=>id==='valid'?{address:account,method:'passkey'}:null}});
  const server=createServer((req,res)=>api(req,res,()=>{res.statusCode=404;res.end();}));
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const host=`127.0.0.1:${(server.address() as any).port}`;hosts.push(host);
  const call=(suffix='',body?:unknown,cookie='valid',site=`http://${host}`)=>fetch(`http://${host}/api/account/wallets${suffix}`,{method:body?'POST':'GET',headers:{Origin:site,'Content-Type':'application/json',Cookie:`flurbo_session=${cookie}`},body:body?JSON.stringify(body):undefined});
  try{
    assert.equal((await call('',undefined,'')).status,401);
    assert.equal((await call('/challenge',{wallet:signer.address},'valid','https://evil.example')).status,403);
    assert.equal((await call('/challenge',{wallet:signer.address,account:other.address})).status,400);
    const proof=await(await call('/challenge',{wallet:signer.address})).json();
    assert.match(proof.message,/does not move funds/);
    const verified=await call('/verify',{id:proof.id,signature:await signer.signMessage({message:proof.message})});
    assert.equal(verified.status,200);
    assert.deepEqual(await(await call()).json(),{account,wallets:[signer.address.toLowerCase()]});
    assert.equal((await call('/verify',{id:proof.id,signature:await signer.signMessage({message:proof.message})})).status,400);
  }finally{await new Promise<void>(r=>server.close(()=>r()));}
});
