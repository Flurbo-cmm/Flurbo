import assert from 'node:assert/strict';
import {test} from 'node:test';
import {request as httpRequest} from 'node:http';
import {previewAccess} from '../server/preview-access.mjs';
import {hostedConfig,TESTNET} from '../server/network.mjs';
import {productionServer} from '../server/production.mjs';
import {DEFAULT_TESTING_OPERATOR} from '../server/testing-access.mjs';
import {pilotFixture} from './pilot-fixture.ts';

const account='0x'+'ab'.repeat(20),other='0x'+'cd'.repeat(20),origin='https://flurbo.singu.online';
test('invite configuration denies by default, validates inputs, and approves only verified Mera identities',()=>{
  const env={FLURBO_ORIGIN:origin,FLURBO_NETWORK:'public_testnet'};
  assert.equal(hostedConfig(env).previewAccess.allows({address:account,method:'passkey'}),false);
  assert.throws(()=>previewAccess({FLURBO_TESTNET_APPROVED_ACCOUNTS:'not-an-address'}));
  assert.throws(()=>previewAccess({FLURBO_TESTNET_APPLICATION_URL:'javascript:alert(1)'}));
  assert.throws(()=>previewAccess({FLURBO_TESTNET_APPLICATION_URL:'https://secret@example.com/'}));
  const access=previewAccess({FLURBO_TESTNET_APPROVED_ACCOUNTS:' '+account.toUpperCase()+', '+account,FLURBO_TESTNET_APPLICATION_URL:'https://docs.google.com/forms/d/e/example/viewform'});
  assert.equal(access.allows({address:account,method:'passkey'}),true);
  assert.equal(access.allows({address:account,method:'wallet'}),false);
  assert.equal(access.allows({address:other,method:'passkey'}),false);
});

test('hosted invite checks cover every app route, preserve evidence and auth, and never trust request addresses',async()=>{
  const fixture=pilotFixture();
  fixture.service.payouts={refresh:async()=>({complete:true,logs:[]})};
  let policy=previewAccess({FLURBO_TESTNET_APPROVED_ACCOUNTS:account});
  const store={read:async(id:string)=>id==='approved'?{address:account,method:'passkey'}:id==='pending'?{address:other,method:'passkey'}:id==='operator'?{address:DEFAULT_TESTING_OPERATOR,method:'passkey'}:id==='wallet'?{address:account,method:'wallet'}:null};
  const ns='practice-'+fixture.manifest.pool.slice(2);
  const server=productionServer({origin,rpcUrl:TESTNET.rpc,previewAccess:{allows:(s:unknown)=>policy.allows(s),applicationUrl:null},pilot:fixture.service,practiceCollections:{services:new Map([[ns,fixture.service]]),catalog:{collections:[{namespace:ns,label:'Fixture',pool:fixture.manifest.pool,closesAt:fixture.manifest.publication.draft.closesAt}]}},pilotEvidence:{get:async()=>'{"evidence":true}'}},store);
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const request=(path:string,id='',body?:object):Promise<any>=>new Promise((resolve,reject)=>{
    const req=httpRequest({hostname:'127.0.0.1',port:(server.address() as any).port,path,method:body?'POST':'GET',headers:{host:'flurbo.singu.online',origin,'content-type':'application/json',cookie:'flurbo_session='+id}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(text)}));});req.on('error',reject);req.end(body?JSON.stringify(body):undefined);
  });
  try{
    assert.deepEqual((await request('/api/preview')).data,{inviteOnly:true,applicationUrl:null});
    assert.equal((await request('/api/auth/session','pending')).status,200);
    assert.equal((await request('/api/account/access','pending')).data.approved,false);
    assert.equal((await request('/api/account/access','approved')).data.approved,true);
    assert.equal((await request('/api/account/access','operator')).data.approved,true);
    for(const route of ['/api/market-directory','/api/practice-collections','/api/account/wallets','/api/network','/api/state','/api/quote','/api/portfolio','/api/markets/learning/state']){
      assert.equal((await request(route)).status,401,route);
      assert.equal((await request(route,'pending')).status,403,route);
      assert.equal((await request(route,account)).status,401,route);
    }
    for(const namespace of ['pilot',ns]){
      for(const endpoint of ['markets','status','price-history'])assert.equal((await request('/api/'+namespace+'/'+endpoint,'pending')).status,403);
      for(const endpoint of ['prepare','positions','analytics','history','collected-payouts','challenge-eligibility','rpc','evidence'])assert.equal((await request('/api/'+namespace+'/'+endpoint,'pending',{owner:account,approved:true})).status,403);
      assert.equal((await request('/api/'+namespace+'/markets','approved')).status,200);
      assert.equal((await request('/api/'+namespace+'/collected-payouts','approved',{})).status,200);
      assert.equal((await request('/api/'+namespace+'/collected-payouts','',{})).status,401);
      assert.equal((await request('/api/'+namespace+'/markets','wallet')).status,401);
      assert.equal((await request('/api/'+namespace+'/evidence/0x'+'ab'.repeat(32))).status,200);
    }
    assert.equal((await request('/api/account/wallets/verify','pending',{wallet:account})).status,403);
    assert.equal((await request('/api/rpc','pending',{method:'eth_call',params:[]})).status,403);
    const directory=(await request('/api/market-directory','approved')).data;
    assert.equal(directory.schema,'flurbo.market-directory.v1');assert.equal(directory.markets.length,1,'Same pool must not appear twice');
    // Reconfiguring approval rejects an existing cookie; session lifetime is not an invitation.
    policy=previewAccess();
    assert.equal((await request('/api/account/access','approved')).data.approved,false);
    assert.equal((await request('/api/pilot/markets','approved')).status,403);
  }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
