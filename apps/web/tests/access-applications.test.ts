import assert from 'node:assert/strict';
import {test} from 'node:test';
import {request as httpRequest} from 'node:http';
import {applicationService,configureApplications} from '../server/access-applications.mjs';
import {productionServer} from '../server/production.mjs';
import {previewAccess} from '../server/preview-access.mjs';
import {DEFAULT_TESTING_OPERATOR} from '../server/testing-access.mjs';

const account='0x'+'ab'.repeat(20),other='0x'+'cd'.repeat(20),origin='https://flurbo.singu.online';
test('application transport is disabled by default and confines privileged credentials to the configured database',async()=>{
  assert.equal(configureApplications({}),null);
  const env={FLURBO_APPLICATIONS_ENABLED:'true',FLURBO_APPLICATIONS_SUPABASE_URL:'https://example.supabase.co',FLURBO_APPLICATIONS_SUPABASE_SECRET:'sb_secret_test',FLURBO_APPLICATIONS_RESEND_KEY:'test',FLURBO_APPLICATIONS_EMAIL_FROM:'invites@example.com',FLURBO_APPLICATIONS_CODE_SECRET:'x'.repeat(32)};
  assert.throws(()=>configureApplications({...env,FLURBO_APPLICATIONS_SUPABASE_URL:'http://localhost'}));
  const calls:any[]=[];
  const service=configureApplications(env,async(url:any,options:any)=>{calls.push({url:String(url),options});return new Response(JSON.stringify({decision:null}));})!;
  assert.equal(await service.allows(account,true),true);
  assert.equal(await service.allows(account,false),false);
  assert.equal(calls[0].url,'https://example.supabase.co/rest/v1/rpc/flurbo_application');
  assert.equal(calls[0].options.headers.apikey,'sb_secret_test');
  assert.equal(calls[0].options.headers.Authorization,undefined);
  const broken=configureApplications(env,async()=>{throw Error('secret upstream failure');})!;
  await assert.rejects(()=>broken.allows(account,true),/temporarily unavailable/);
});
test('codes are keyed, account-bound and never returned; delivery failure preserves application and blocks admin impersonation',async()=>{
  const writes:any[]=[],mail:any[]=[];
  const service=applicationService({secret:'fixture secret',db:async(action:string,id:string,data:any)=>{
    writes.push({action,id,data});return action==='submit'?{send:true,application:{state:'unverified'}}:{application:{state:'pending'}};
  },send:async(message:any)=>{mail.push(message);throw Error('provider failed');}});
  const result=await service.handle({action:'submit',account,input:{email:'person@example.com',noticeAccepted:true,account:other}});
  assert.equal(result.delivery,'pending');assert.equal(result.application.state,'unverified');
  const code=mail[0].text.match(/code is (\d{6})/)[1];
  assert.equal(JSON.stringify(result).includes(code),false);assert.match(writes[0].data.codeHash,/^[a-f0-9]{64}$/);
  assert.equal(writes[0].id,account);
  await service.handle({action:'verify',account,input:{code}});
  assert.equal(writes[1].data.codeHash,writes[0].data.codeHash);
  await service.handle({action:'verify',account:other,input:{code}});
  assert.notEqual(writes[2].data.codeHash,writes[0].data.codeHash);
  await assert.rejects(()=>service.handle({action:'admin/decide',account,input:{account:other,decision:'approved',revision:0}}),/Operator access/);
  await assert.rejects(()=>service.handle({action:'submit',account,input:{email:'person@example.com'}}),/acknowledge/);
});
test('notification failure cannot roll back approval and retry uses the same delivery identity',async()=>{
  const sends:string[]=[];let decided=false,delivered=false;
  const service=applicationService({secret:'test',db:async(action:string)=>{
    if(action==='decide'){decided=true;return {application:{state:'approved'}};}
    if(action==='notification')return {id:'same-event',email:'person@example.com',expired:false};
    if(action==='notified')delivered=true;
    return {};
  },send:async(message:any)=>{sends.push(message.id);if(sends.length===1)throw Error('unknown delivery');}});
  const result=await service.handle({action:'admin/decide',account:DEFAULT_TESTING_OPERATOR,operator:true,input:{account,decision:'approved',revision:2}});
  assert.equal(decided,true);assert.equal(result.notification,'pending');assert.equal(delivered,false);
  await service.handle({action:'admin/notify',account:DEFAULT_TESTING_OPERATOR,operator:true,input:{account}});
  assert.equal(delivered,true);assert.deepEqual(sends,['same-event','same-event']);
});
test('native routes allow pending applicants, isolate accounts and keep approval gates closed until the shared decision allows access',async()=>{
  let decision:string|null=null,down=false;const calls:any[]=[];
  const applications={allows:async(_a:string,legacy:boolean)=>{if(down)throw Error('database down');return decision===null?legacy:decision==='approved';},handle:async(input:any)=>{calls.push(input);return {application:null};}};
  const store={read:async(id:string)=>id==='applicant'?{address:account,method:'passkey'}:id==='other'?{address:other,method:'passkey'}:id==='operator'?{address:DEFAULT_TESTING_OPERATOR,method:'passkey'}:null};
  const server=productionServer({origin,rpcUrl:'https://testnet-rpc.monad.xyz',applications,previewAccess:previewAccess({FLURBO_TESTNET_APPROVED_ACCOUNTS:other})},store);
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const request=(path:string,id='',body?:object,from=origin):Promise<any>=>new Promise((resolve,reject)=>{
    const req=httpRequest({hostname:'127.0.0.1',port:(server.address() as any).port,path,method:body?'POST':'GET',headers:{host:'flurbo.singu.online',origin:from,'content-type':'application/json',cookie:'flurbo_session='+id}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(text)}));});req.on('error',reject);req.end(body?JSON.stringify(body):undefined);
  });
  try{
    assert.equal((await request('/api/preview')).data.nativeApplications,true);
    assert.equal((await request('/api/account/application')).status,401);
    assert.equal((await request('/api/account/application/submit','applicant',{email:'a@example.com',account:other})).status,200);
    assert.equal(calls.at(-1).account,account);
    assert.equal((await request('/api/account/application','other')).status,200);assert.equal(calls.at(-1).account,other);
    assert.equal((await request('/api/account/application/admin/list','applicant',{})).status,403);
    assert.equal((await request('/api/account/application/admin/list','operator',{})).status,200);
    assert.equal((await request('/api/account/application/submit','applicant',{},'https://evil.example')).status,403);
    assert.equal((await request('/api/network','applicant')).status,403);
    assert.equal((await request('/api/network','other')).status,200);
    decision='approved';assert.equal((await request('/api/network','applicant')).status,200);
    decision='revoked';assert.equal((await request('/api/network','other')).status,403,'Recorded revocation overrides legacy allowlist');
    down=true;assert.equal((await request('/api/account/access','applicant')).status,503);
    assert.equal((await request('/api/account/access','operator')).data.approved,true);
  }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
