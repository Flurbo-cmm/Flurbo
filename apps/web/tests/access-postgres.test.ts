import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {applicationService} from '../server/access-applications.mjs';

const container=process.env.FLURBO_TEST_POSTGRES_CONTAINER;
function sql(source:string):Promise<string>{return new Promise((resolve,reject)=>{
  const child=spawn('docker',['exec','-i',container!,'psql','-U','postgres','-At','-v','ON_ERROR_STOP=1'],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  let out='',err='';child.stdout.on('data',c=>out+=c);child.stderr.on('data',c=>err+=c);child.on('error',reject);
  child.on('exit',code=>code===0?resolve(out.trim()):reject(Error(err)));child.stdin.end(source);
});}
const literal=(value:string)=>"'"+value.replaceAll("'","''")+"'";
test('real Postgres: migration, atomic codes, concurrent decisions, replay, withdrawal and database privileges',{skip:!container},async()=>{
  await sql("do $$ begin create role anon; exception when duplicate_object then null; end $$; do $$ begin create role authenticated; exception when duplicate_object then null; end $$; do $$ begin create role service_role; exception when duplicate_object then null; end $$;");
  await sql(await readFile(new URL('../server/migrations/001_access_applications.sql',import.meta.url),'utf8'));
  await sql('truncate public.flurbo_applications, public.flurbo_access_audit, public.flurbo_application_mail_days;');
  const raw=async(action:string,account:string,data:object={})=>JSON.parse((await sql(`set role service_role; select public.flurbo_application(${literal(action)},${literal(account)},${literal(JSON.stringify(data))}::jsonb);`)).split('\n').at(-1)!);
  const db=async(action:string,account:string,data:object={})=>{const r=await raw(action,account,data);if(r.error)throw Error(r.error);return r;};
  const mails:any[]=[];const service=applicationService({db,secret:'test secret',send:async(v:any)=>{mails.push(v);}});
  const a='0x'+'ab'.repeat(20),b='0x'+'cd'.repeat(20),operator='0x'+'ef'.repeat(20);
  const emails=await Promise.all([raw('email_budget',a,{limit:1}),raw('email_budget',b,{limit:1})]);
  assert.equal(emails.filter(x=>x.status===429).length,1,'Daily email allowance is atomic across accounts');
  assert.equal((await db('status',a)).application,null);
  assert.equal(await service.allows(a,true),true);
  // Two instances attempting submission at once must create only one current code.
  const submitted=await Promise.allSettled([1,2].map(()=>service.handle({action:'submit',account:a,input:{email:'test@example.com',noticeAccepted:true}})));
  assert.equal(submitted.filter(x=>x.status==='fulfilled').length,1);assert.equal(mails.length,1);
  const code=mails[0].text.match(/code is (\d{6})/)[1];
  assert.equal((await db('status',a)).application.state,'unverified');
  assert.equal((await raw('decide',a,{revision:0,operator,decision:'approved'})).status,409);
  assert.equal((await raw('verify',b,{codeHash:'0'.repeat(64)})).status,404);
  const verified=await Promise.allSettled([1,2].map(()=>service.handle({action:'verify',account:a,input:{code}})));
  assert.equal(verified.filter(x=>x.status==='fulfilled').length,1);
  const pending=(await db('status',a)).application;
  const duplicate=await service.handle({action:'submit',account:a,input:{email:'test@example.com',noticeAccepted:true}});
  assert.equal(duplicate.application.state,'pending');assert.equal(mails.length,1);
  const decisions=await Promise.all([raw('decide',a,{revision:pending.revision,operator,decision:'approved'}),raw('decide',a,{revision:pending.revision,operator,decision:'declined'})]);
  assert.equal(decisions.filter(x=>x.application).length,1);assert.equal(decisions.filter(x=>x.status===409).length,1);
  let current=(await db('status',a)).application;
  if(current.state!=='approved'){await db('decide',a,{revision:current.revision,operator,decision:'approved'});current=(await db('status',a)).application;}
  assert.equal(await service.allows(a),true);
  const notification=await db('notification',a);assert.ok(notification.id);
  assert.equal((await db('notification',a)).id,notification.id);
  await db('notified',a,{id:notification.id});assert.deepEqual(await db('notification',a),{});
  await db('decide',a,{revision:current.revision,operator,decision:'revoked'});
  assert.equal(await service.allows(a,true),false);
  await db('withdraw',a);assert.equal((await db('status',a)).application.email,null);assert.equal(await service.allows(a,true),false);
  await service.handle({action:'submit',account:b,input:{email:'other@example.com',noticeAccepted:true}});
  for(let i=0;i<5;i++)assert.equal((await raw('verify',b,{codeHash:'0'.repeat(64)})).status,400);
  const otherCode=mails.at(-1).text.match(/code is (\d{6})/)[1];
  await assert.rejects(()=>service.handle({action:'verify',account:b,input:{code:otherCode}}),/no longer available/);
  await sql(`update public.flurbo_applications set sent_at=now()-interval '2 minutes' where account=${literal(b)};`);
  await service.handle({action:'submit',account:b,input:{email:'changed@example.com',noticeAccepted:true}});
  await sql(`update public.flurbo_applications set code_expires=now()-interval '1 second' where account=${literal(b)};`);
  await assert.rejects(()=>service.handle({action:'verify',account:b,input:{code:mails.at(-1).text.match(/code is (\d{6})/)[1]}}),/no longer available/);
  await db('withdraw',b);assert.equal((await db('status',b)).application.email,null);
  assert.equal((await db('list',operator,{offset:0})).applications.length,2);
  await assert.rejects(()=>sql('set role anon; select * from public.flurbo_applications;'),/permission denied/);
  await assert.rejects(()=>sql(`set role authenticated; select public.flurbo_application('list',${literal(operator)},'{}');`),/permission denied/);
});
