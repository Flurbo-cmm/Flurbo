import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {encodeAbiParameters,encodeEventTopics,decodeFunctionData,encodeFunctionResult} from 'viem';
import {pilotPoolAbi} from '../shared/pilot.mjs';
import {assessSemantics,semanticRegistry} from '../server/semantic-validation.mjs';
import {alice,origin,setup} from './agent-fixture.ts';
import {owner,hash,code} from './pilot-fixture.ts';

// End to end: the real agent API and strategy run in-process over the pilot fixture; the browser drives the
// real UI with a fake MetaMask. Nothing reaches a network, and every MetaMask send is counted.
async function harness(browser:any,{failTracking=0,collision=false}={}){
  const at=Math.floor(Date.now()/1000),s=setup({at}),pool=s.f.manifest.pool,errors:string[]=[],tracked:number[]=[];let failures=failTracking;
  if(collision){
    // This fixture quotes the AND cheaply enough for the strategy to propose it.
    // Other claims cost more; the production strategy and semantic checker stay real.
    const original=s.f.rpc;
    s.f.rpc=async(method:string,params:any[]=[])=>{
      if(method==='eth_call'&&params[0]?.to===pool){
        const decoded=decodeFunctionData({abi:pilotPoolAbi,data:params[0].data});
        if(decoded.functionName==='quoteBuy')return encodeFunctionResult({abi:pilotPoolAbi,functionName:'quoteBuy',result:decoded.args[0]===3&&decoded.args[1]===8n?250_000n:900_000n});
      }
      return original(method,params);
    };
  }
    const page=await browser.newPage({viewport:{width:1280,height:1000}});
    page.on('pageerror',(e:Error)=>errors.push(e.message));
    await page.addInitScript(({owner,hash,code}:any)=>{
      const listeners:Record<string,(()=>void)[]>={};let account=owner;
      (window as any).__switchAccount=(next:string)=>{account=next;(listeners.accountsChanged||[]).forEach(f=>f());};
      (window as any).ethereum={isMetaMask:true,on:(e:string,f:()=>void)=>{(listeners[e]??=[]).push(f);},removeListener:(e:string,f:()=>void)=>{listeners[e]=(listeners[e]||[]).filter(x=>x!==f);},
        request:async({method}:any)=>{
          if(['eth_accounts','eth_requestAccounts'].includes(method))return[account];
          if(method==='eth_chainId')return'0x279f';
          if(method==='eth_getBlockByNumber')return{number:'0x65',hash};
          if(method==='eth_getCode')return code;
          if(method==='eth_call')return'0x';
          if(method==='eth_estimateGas')return'0x186a0';
          if(method==='eth_gasPrice')return'0x3b9aca00';
          if(method==='eth_getBalance')return'0xde0b6b3a7640000';
          if(method==='eth_getTransactionCount')return 7;
          if(method==='eth_sendTransaction'){
            if(sessionStorage.getItem('reject')){sessionStorage.removeItem('reject');throw Object.assign(Error('Rejected'),{code:4001});}
            const pending=JSON.parse(localStorage.getItem('flurbo.pilot.pending.v1')||'null');
            if(!pending||pending.hash!==null)throw Error('Missing saved intent');
            const n=Number(sessionStorage.getItem('sends')||0)+1;sessionStorage.setItem('sends',String(n));
            return '0x'+String(n).padStart(2,'0').repeat(32);
          }
          throw Error(method);
        }};
    },{owner,hash,code});
    await page.route('**/*',async(route:any)=>{
      const url=new URL(route.request().url()),path=url.pathname,method=route.request().method();
      if(path==='/api/auth/session')return route.fulfill({json:{session:{address:alice,method:'passkey',expiresAt:Date.now()+3600000}}});
      if(path==='/api/account/access')return route.fulfill({json:{approved:true,testingTools:false}});
      if(path==='/api/market-directory')return route.fulfill({json:{schema:'flurbo.market-directory.v1',markets:[{namespace:'pilot',label:'Release fixture',pool,closesAt:s.f.manifest.publication.draft.closesAt}]}});
      if(path==='/api/account/wallets')return route.fulfill({json:{account:alice,wallets:[owner]}});
      if(path==='/api/pilot/markets')return route.fulfill({json:await s.f.service.markets()});
      // Purchases re-check outcome compatibility right before the wallet prompt; answer as the server would.
      if(path==='/api/pilot/validate-trade')return route.fulfill({json:assessSemantics(s.f.manifest,route.request().postDataJSON(),collision ? semanticRegistry(JSON.stringify({schema:'flurbo.semantic-rules.v1',markets:[{pool,rulesHash:s.f.manifest.rulesHash,predicates:[
        {event:0,observation:'test:close',operator:'gte',value:'3000',sourceRule:'Fixture closing observation.'},
        {event:1,observation:'test:close',operator:'lt',value:'2500',sourceRule:'Fixture closing observation.'}]}]})) : undefined)});
      if(path==='/api/agents'||path.startsWith('/api/agents/')){
        const input=method==='POST'?route.request().postDataJSON():undefined;
        if(input?.action==='submitted'){tracked.push(Date.now());if(failures>0){failures--;return route.fulfill({status:503,json:{error:'The agent service is temporarily unavailable. Nothing was traded.'}});}}
        if(input?.action==='check'){
          // The chain includes the transaction MetaMask sent; the server-side verifier reads it from there.
          const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('flurbo.pilot.pending.v1')||'null'));
          if(saved?.hash){
            const buy=saved.review.action==='buy',args=buy?decodeFunctionData({abi:pilotPoolAbi,data:saved.review.transaction.data}).args as any[]:null;
            const logs=buy?[{address:pool,topics:encodeEventTopics({abi:pilotPoolAbi,eventName:'Traded',args:{trader:owner,scope:args![0],mask:args![1]}}),
              data:encodeAbiParameters([{type:'bool'},{type:'uint128'},{type:'uint128'}],[true,args![2],250_000n])}]:[];
            s.mine(saved.review.transaction,saved.hash,{logs});
            if(saved.review.action==='approve')s.f.options.allowance=10n**12n;
          }
        }
        const result=await s.api.handle({method,path,input,login:{address:alice,method:'passkey'},origin});
        return route.fulfill({status:result.status,json:result.body});
      }
      if(path.startsWith('/api/'))return route.fulfill({status:503,json:{error:'Fixture unavailable'}});
      const relative=path.startsWith('/assets/')?path.slice(1):'index.html';
      return route.fulfill({body:await readFile(new URL('../dist/'+relative,import.meta.url)),contentType:relative.endsWith('.js')?'text/javascript':relative.endsWith('.css')?'text/css':relative.endsWith('.woff2')?'font/woff2':'text/html'});
    });
  const sends=()=>page.evaluate(()=>Number(sessionStorage.getItem('sends')||0));
  const saved=()=>page.evaluate(()=>JSON.parse(localStorage.getItem('flurbo.pilot.pending.v1')||'null'));
  return {s,page,errors,sends,saved,tracked,pool};
}

async function createAgentAndDecide(page:any){
    // Create an agent that may propose trades for approval.
    await page.goto(origin+'/agents');
    // Assisted agents are the secondary workflow; the primary form registers an agent that runs elsewhere.
    await page.getByRole('heading',{name:'Register an agent'}).waitFor();
    // The page is inert under the loading cover, so typing there is dropped. Wait for the loaded page itself
    // (agent list and market choices rendered, cover gone), not just for the cover to be absent.
    await page.waitForFunction(()=>{const root=document.querySelector('.app-root') as HTMLElement|null;return !!root&&!root.inert&&!document.querySelector('.contour-loader')&&!!document.querySelector('.agents-list')&&!document.querySelector('.agents-rows-skeleton')&&!!document.querySelector('#register-agent input[type=checkbox]');});
    await page.getByText('Assisted agent: manual forecasts, paper trades and MetaMask approval').click();
    const assisted=page.locator('details').filter({has:page.getByRole('heading',{name:'Create an assisted agent'})});
    await assisted.getByLabel('Name').fill('Release relationship agent');
    await assisted.getByRole('radio',{name:/Propose for approval/}).check();
    await assisted.getByRole('button',{name:'Create assisted agent'}).click();
    await page.waitForURL(/\/agents\/[0-9a-f-]{36}$/);
    await page.getByRole('heading',{name:'Release relationship agent'}).waitFor();
    // The agent page has its own loading cover; wait for it to lift before typing.
    await page.waitForFunction(()=>{const root=document.querySelector('.app-root') as HTMLElement|null;return !!root&&!root.inert&&!document.querySelector('.contour-loader');});

    // A contradictory forecast is rejected, not displayed as coherent.
    await page.getByLabel('Chance A happens (%)').fill('60');await page.getByLabel('Chance B happens (%)').fill('55');await page.getByLabel('Chance both happen (%)').fill('80');
    await page.getByText('"both" must be between 15.0% and 55.0%').waitFor();
    await page.getByLabel('What you observed').fill('Both release branches were tagged the same day');
    await page.getByLabel('Source').fill('Project release page');
    const local=new Date(Date.now()-3600_000-new Date().getTimezoneOffset()*60_000).toISOString().slice(0,16);
    await page.getByLabel('Observed at').fill(local);
    await page.getByLabel('Why you expect this relationship').fill('The releases share a dependency, so they tend to ship together.');
    await page.getByLabel('Uncertainty').fill('A late security fix could split them.');
    await page.getByRole('button',{name:'Preview decision'}).click();
    await page.getByRole('alert').filter({hasText:'chance of both'}).waitFor();
    await page.getByLabel('Chance both happen (%)').fill('45');
    await page.getByRole('button',{name:'Preview decision'}).click();
    const decision=page.getByRole('region',{name:'Latest decision'});
    await decision.getByRole('heading',{name:'Proposed purchase'}).waitFor();
    await decision.getByText('(a finite-size cost, not a probability)',{exact:false}).waitFor();
    await decision.getByText('VOID events pay a fraction under the published rules.',{exact:false}).waitFor();
    return decision;
}

const browserTest=(name:string,fn:(browser:any)=>Promise<void>)=>test(name,{skip:!process.env.FLURBO_TEST_PLAYWRIGHT},async()=>{
  const {chromium}=await import(pathToFileURL(process.env.FLURBO_TEST_PLAYWRIGHT!).href);
  const browser=await chromium.launch({headless:true,executablePath:process.env.FLURBO_TEST_BROWSER});
  try{await fn(browser);}finally{await browser.close();}
});

browserTest('agent approval explains a fresh semantic collision without an override or wallet send',async browser=>{
  const {s,page,errors,sends,saved}=await harness(browser,{collision:true});
  s.f.options.allowance=10n**12n;
  const decision=await createAgentAndDecide(page);
  await decision.getByRole('button',{name:'Prepare for MetaMask approval'}).click();
  const approvals=page.getByRole('region',{name:'Awaiting approval'});
  await approvals.getByText('connected with',{exact:false}).waitFor();
  await approvals.getByRole('button',{name:'Confirm purchase in MetaMask'}).click();
  const proposal=(await s.api.handle({method:'GET',path:new URL(page.url()).pathname.replace('/agents/','/api/agents/'),login:{address:alice,method:'passkey'},origin})).body.records.find((r:any)=>r.kind==='proposal');
  assert.equal(proposal.claim.scope,3,JSON.stringify(proposal.claim));
  assert.equal(proposal.claim.mask,'8',JSON.stringify(proposal.claim));
  const conflict=approvals.getByRole('region',{name:'Outcome conflict'});
  await conflict.getByText('This agent purchase is blocked.',{exact:false}).waitFor();
  assert.match(await conflict.textContent(),/VOID settlement is different/);
  assert.equal(await conflict.locator('input').count(),0,'agent approvals never offer an acknowledgment override');
  assert.equal(await sends(),0);
  assert.equal(await saved(),null);
  await approvals.getByRole('button',{name:'Refresh review'}).click();
  await conflict.waitFor({state:'detached'});
  assert.deepEqual(errors,[]);
});

browserTest('agent flow: create, forecast, paper trade, then user-approved purchase with rejection, wallet switch and reload recovery',async browser=>{
    const {page,errors,sends}=await harness(browser);
    const decision=await createAgentAndDecide(page);

    // Paper trade: clearly simulated, never on-chain.
    await decision.getByRole('button',{name:'Record paper trade'}).click();
    await page.getByText('Paper trade recorded',{exact:true}).waitFor();
    await page.getByText('(simulated, not on-chain)',{exact:false}).first().waitFor();
    assert.equal(await sends(),0);

    // Prepare for approval: first an exact token approval, which is not a purchase.
    await decision.getByRole('button',{name:'Prepare for MetaMask approval'}).click();
    const approvals=page.getByRole('region',{name:'Awaiting approval'});
    await approvals.getByText('Step 1: approve exactly',{exact:false}).waitFor();
    await approvals.getByText('connected with',{exact:false}).waitFor();

    // A wallet switch invalidates the prepared review.
    await page.evaluate(()=>(window as any).__switchAccount('0x'+'77'.repeat(20)));
    await approvals.getByText('the selected wallet is not linked to this account',{exact:false}).waitFor();
    await approvals.getByRole('button',{name:'Approve allowance in MetaMask'}).click();
    await approvals.getByRole('alert').filter({hasText:'Select the MetaMask wallet this proposal was prepared for'}).waitFor();
    await page.evaluate((owner:string)=>(window as any).__switchAccount(owner),owner);
    await approvals.getByText('connected with',{exact:false}).waitFor();

    // Rejection in MetaMask: nothing sent, tracking cleared, proposal marked rejected.
    await page.evaluate(()=>sessionStorage.setItem('reject','1'));
    await approvals.getByRole('button',{name:'Approve allowance in MetaMask'}).click();
    await page.getByText('Rejected in MetaMask',{exact:false}).first().waitFor();
    assert.equal(await sends(),0);
    assert.equal(await page.evaluate(()=>localStorage.getItem('flurbo.pilot.pending.v1')),null);

    // A fresh proposal, approved; then reload before confirmation.
    await decision.getByRole('button',{name:'Prepare for MetaMask approval'}).click();
    await approvals.getByRole('button',{name:'Approve allowance in MetaMask'}).click();
    await approvals.getByText('Submitted, waiting for confirmation').waitFor();
    assert.equal(await sends(),1);
    await page.reload();
    const reloaded=page.getByRole('region',{name:'Awaiting approval'});
    await reloaded.getByRole('button',{name:'Check confirmation'}).click();
    await reloaded.getByText('Token approval confirmed. Purchase not sent yet.').waitFor();
    assert.equal(await sends(),1,'reload never resends');

    // The purchase itself, carrying the same claim, then a verified receipt.
    await reloaded.getByRole('button',{name:'Prepare the purchase'}).click();
    await reloaded.getByText('Buy 1 share(s), paying at most',{exact:false}).waitFor();
    await reloaded.getByRole('button',{name:'Confirm purchase in MetaMask'}).click();
    await reloaded.getByRole('button',{name:'Check confirmation'}).click();
    await page.getByText('Purchase confirmed on-chain',{exact:false}).first().waitFor();
    assert.equal(await sends(),2,'exactly one approval and one purchase were sent');

    await page.getByRole('button',{name:'Refresh results'}).click();
    await page.getByText('Confirmed purchases').waitFor();
    if(process.env.FLURBO_TEST_SCREENSHOT)await page.screenshot({path:process.env.FLURBO_TEST_SCREENSHOT,fullPage:true});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'no horizontal scroll on a phone');
    assert.deepEqual(errors,[]);
});

browserTest('a purchase sent from MetaMask whose tracking request failed is recovered after reload and never sent twice',async browser=>{
  const {s,page,errors,sends,saved,tracked}=await harness(browser,{failTracking:1});
  s.f.options.allowance=10n**12n; // allowance already granted, so the first review is the purchase itself
  const decision=await createAgentAndDecide(page);
  await decision.getByRole('button',{name:'Prepare for MetaMask approval'}).click();
  const approvals=page.getByRole('region',{name:'Awaiting approval'});
  await approvals.getByText('connected with',{exact:false}).waitFor();
  await approvals.getByRole('button',{name:'Confirm purchase in MetaMask'}).click();
  // MetaMask returned a hash; recording it on the server failed.
  await approvals.getByRole('alert').filter({hasText:'Do not send it again'}).waitFor();
  assert.equal(await sends(),1);
  const local=await saved();
  assert.match(local.hash,/^0x[0-9a-f]{64}$/,'the hash is kept locally until the server records it');
  const [agentId,proposal]=await (async()=>{const id=page.url().split('/').pop();const r=(await s.api.handle({method:'GET',path:'/api/agents/'+id,login:{address:alice,method:'passkey'},origin})).body.records.find((x:any)=>x.kind==='proposal');return [id,r];})();
  assert.equal(proposal.status,'awaiting-approval');assert.equal(proposal.transactions.length,0,'the server did not record the hash yet');
  assert.equal(await approvals.getByRole('button',{name:'Confirm purchase in MetaMask'}).isDisabled(),true,'a second send is blocked while the hash is unrecorded');
  await approvals.getByRole('button',{name:'Resume tracking'}).waitFor();

  // Reload: the saved hash is matched to this proposal and recorded without asking MetaMask again.
  await page.reload();
  const reloaded=page.getByRole('region',{name:'Awaiting approval'});
  await reloaded.getByText('Submitted, waiting for confirmation').waitFor();
  assert.equal(tracked.length,2,'one failed and one successful registration');
  assert.equal((await saved()).hash,local.hash,'still kept locally until the transaction is resolved');
  await reloaded.getByRole('button',{name:'Check confirmation'}).click();
  await page.getByText('Purchase confirmed on-chain',{exact:false}).first().waitFor();
  await page.waitForFunction(()=>localStorage.getItem('flurbo.pilot.pending.v1')===null);
  const after=(await s.api.handle({method:'GET',path:'/api/agents/'+agentId,login:{address:alice,method:'passkey'},origin})).body.records.find((x:any)=>x.id===proposal.id);
  assert.equal(after.status,'confirmed');assert.deepEqual(after.transactions.map((t:any)=>t.hash),[local.hash]);
  assert.equal(await sends(),1,'exactly one purchase was sent');
  const perf=(await s.api.handle({method:'POST',path:`/api/agents/${agentId}/performance`,input:{},login:{address:alice,method:'passkey'},origin})).body;
  assert.equal(perf.live.confirmedPurchases,1);
  assert.deepEqual(errors,[]);
});

browserTest('a sent purchase is recovered from an archived agent after its review expired, without a second send',async browser=>{
  const {s,page,errors,sends,saved}=await harness(browser,{failTracking:1});
  s.f.options.allowance=10n**12n;
  const decision=await createAgentAndDecide(page);
  await decision.getByRole('button',{name:'Prepare for MetaMask approval'}).click();
  const approvals=page.getByRole('region',{name:'Awaiting approval'});
  await approvals.getByText('connected with',{exact:false}).waitFor();
  await approvals.getByRole('button',{name:'Confirm purchase in MetaMask'}).click();
  await approvals.getByRole('alert').filter({hasText:'Do not send it again'}).waitFor();
  const local=await saved(),agentUrl=page.url();
  assert.equal(await sends(),1);
  // Two days pass on the server (the review expired), then the agent is deleted before recovery.
  s.advance(2*86_400);
  await page.getByRole('button',{name:'Delete'}).click();
  await page.getByRole('button',{name:'Confirm delete'}).click();
  await page.waitForURL(/\/agents$/);
  await page.getByText('Archived agents (1)').click();
  await page.getByRole('link',{name:/Release relationship agent/}).click();
  await page.waitForURL(agentUrl);
  await page.getByText('This agent is archived.',{exact:false}).waitFor();
  const recovered=page.getByRole('region',{name:'Awaiting approval'});
  await recovered.getByText('Submitted, waiting for confirmation').waitFor();
  assert.equal(await recovered.getByRole('button',{name:/in MetaMask/}).count(),0,'an archived agent offers nothing to send');
  await recovered.getByRole('button',{name:'Check confirmation'}).click();
  await page.getByText('Purchase confirmed on-chain',{exact:false}).first().waitFor();
  await page.waitForFunction(()=>localStorage.getItem('flurbo.pilot.pending.v1')===null);
  assert.equal(await sends(),1,'recovery never resends');
  const id=agentUrl.split('/').pop();
  const after=(await s.api.handle({method:'GET',path:'/api/agents/'+id,login:{address:alice,method:'passkey'},origin})).body.records.find((x:any)=>x.kind==='proposal');
  assert.deepEqual(after.transactions.map((t:any)=>t.hash),[local.hash]);assert.equal(after.status,'confirmed');
  assert.deepEqual(errors,[]);
});
