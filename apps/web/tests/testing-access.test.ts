import assert from 'node:assert/strict';
import {test} from 'node:test';
import {request as httpRequest} from 'node:http';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {productionServer} from '../server/production.mjs';
import {DEFAULT_TESTING_OPERATOR, testingPages} from '../server/testing-access.mjs';
import {TESTNET} from '../server/network.mjs';

test('operator-only pages, assets and actions use the server session, while consumer trading and evidence remain accessible', async()=>{
  const dir=await mkdtemp(join(tmpdir(),'flurbo-tools-'));
  await writeFile(join(dir,'index.html'),'app');
  let revoked=false;
  const store={read:async(id:string)=>id==='owner'&&!revoked?{address:DEFAULT_TESTING_OPERATOR,method:'passkey',expiresAt:Date.now()+60000}:id==='visitor'?{address:'0x'+'11'.repeat(20),method:'passkey'}:id==='wallet'?{address:DEFAULT_TESTING_OPERATOR,method:'wallet'}:null};
  const service={manifest:{pool:'0x'+'12'.repeat(20),publication:{draft:{events:[{id:'event-0'}]}}}};
  const namespace='practice-'+'12'.repeat(20);
  const server=productionServer({previewAccess:null, origin:'https://flurbo.singu.online',rpcUrl:TESTNET.rpc,agentPools:{collections:[],services:new Map([[namespace,service]]),reservedAddresses:new Set()},evidenceArchive:{get:async()=>'{"public":true}',put:async()=>({saved:true})}},store,dir);
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const port=(server.address() as any).port;
  const request=(path:string,id='',data?:any):Promise<any>=>new Promise((resolve,reject)=>{
    const req=httpRequest({hostname:'127.0.0.1',port,path,method:data?'POST':'GET',headers:{Host:'flurbo.singu.online',Origin:'https://flurbo.singu.online','Content-Type':'application/json',Cookie:`flurbo_session=${id}; flurbo_tools=${id}`}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,text,headers:res.headers}));});req.on('error',reject);req.end(data?JSON.stringify(data):undefined);
  });
  try{
    for(const page of testingPages){
      for(const id of ['', 'visitor', 'wallet', DEFAULT_TESTING_OPERATOR])assert.equal((await request(page,id)).status,404,page);
      const allowed=await request(page,'owner');assert.equal(allowed.status,200,page);assert.equal(allowed.headers['cache-control'],'no-store');
    }
    // The evidence review page went with the pilot resolver.
    assert.equal(testingPages.has('/evidence'),false);
    assert.equal((await request('/evidence','owner')).status,404);
    const access=await request('/api/account/access','owner');assert.equal(JSON.parse(access.text).testingTools,true);assert.match(access.headers['set-cookie'][0],/HttpOnly; SameSite=Strict; Path=\/;/);
    assert.equal(JSON.parse((await request('/api/account/access','visitor')).text).testingTools,false);
    for(const ns of ['pilot',namespace]){
      // Pool actions, operator settlement tools and evidence uploads are no longer served for any namespace,
      // for the operator either; published evidence stays public.
      for(const action of ['assertOutcome','finalize','buy','redeem','dispute']){
        assert.equal((await request(`/api/${ns}/prepare`,'visitor',{action,owner:DEFAULT_TESTING_OPERATOR})).status,404);
        assert.equal((await request(`/api/${ns}/prepare`,'owner',{action})).status,404);
      }
      assert.equal((await request(`/api/${ns}/prepare`,'',{action:'dispute'})).status,401);
      assert.equal((await request(`/api/${ns}/evidence`,'',{eventId:'event-0',outcome:1})).status,401);
      assert.equal((await request(`/api/${ns}/evidence`,'visitor',{eventId:'event-0',outcome:1})).status,404);
      assert.equal((await request(`/api/${ns}/evidence/0x${'ab'.repeat(32)}`)).status,200);
    }
    for(const path of ['/api/learning/comparison','/api/learning/pool'])assert.equal((await request(path,'visitor')).status,403);
    assert.equal((await request('/api/evidence-beta','visitor')).status,404);
    for(const path of ['/api/kuru','/api/kuru-scan'])assert.equal((await request(path,'visitor')).status,404);
    assert.equal((await request('/fund','visitor')).status,200);
    assert.equal((await request('/rehearsal-rules')).status,404);
    assert.equal((await request('/privacy-lab/','owner')).status,404);
    revoked=true;assert.equal((await request('/account','owner')).status,404);
  }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await rm(dir,{recursive:true,force:true});}
});
