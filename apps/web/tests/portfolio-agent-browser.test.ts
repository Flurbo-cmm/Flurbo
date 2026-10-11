import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile,mkdir} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {owner} from './pool-fixture.ts';

test('agent holdings and receipt-verified trades join one portfolio before indexing, with subtle attribution and no MetaMask agent redemption',{skip:!process.env.FLURBO_TEST_PLAYWRIGHT},async()=>{
 const {chromium}=await import(pathToFileURL(process.env.FLURBO_TEST_PLAYWRIGHT!).href),browser=await chromium.launch({headless:true,executablePath:process.env.FLURBO_TEST_BROWSER});
 const login='0x'+'99'.repeat(20),agent='0x'+'88'.repeat(20),errors:string[]=[];
 const pool='0x'+'22'.repeat(20),now=Math.floor(Date.now()/1000),closesAt=now+86400,questions=[1,2,3,4].map(i=>`Test event ${i}`);
 const hybridMarkets=questions.map((question,eventIndex)=>({id:`${pool}-${eventIndex}`,pool,poolTitle:'October',eventIndex,question,route:'mechanical',closesAt,observationEndsAt:closesAt+3600}));
 const snapshot={blockNumber:'210',blockHash:'0x'+'44'.repeat(32),timestamp:now};
 const executions=[{scope:1,mask:'2',cash:'656981'},{scope:3,mask:'8',cash:'345338'}].map((c,i)=>({...c,agentId:'agent-rust',agentName:'Rust October E2E',namespace:'practice-'+pool.slice(2),pool,owner:agent,hash:'0x'+String(i+1).repeat(64),block:200+i,timestamp:1000+i,quantity:'1000000',action:'Buy'}));
 let indexed=false;
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',(e:Error)=>errors.push(e.message));
  await page.route('**/*',async(route:any)=>{
   const u=new URL(route.request().url()),p=u.pathname;
   if(p==='/api/auth/session')return route.fulfill({json:{session:{address:login,method:'passkey',expiresAt:Date.now()+3600000}}});
   if(p==='/api/account/access')return route.fulfill({json:{approved:true}});
   if(p==='/api/account/wallets')return route.fulfill({json:{account:login,wallets:[owner]}});
   if(p==='/api/account/portfolio-sources')return route.fulfill({json:{account:login,wallets:[owner],agentWallets:[agent],agentExecutions:executions}});
   if(p==='/api/market-directory')return route.fulfill({json:{schema:'flurbo.market-directory.v1',markets:[{namespace:'practice-'+pool.slice(2),label:'October',pool,closesAt}],oracleMarkets:[],hybridMarkets}});
   if(p===`/api/hybrid/pool/${pool}/account`)return route.fulfill({json:{schema:'flurbo.hybrid-portfolio-account.v1',manifest:{pool,resolver:'0x'+'33'.repeat(20),chainId:10143,publication:{draft:{title:'October',closesAt,
    events:questions.map((question,i)=>({id:`event-${i}`,question,route:'mechanical',observationEndsAt:closesAt+3600}))}}},snapshot,claimScopes:[]}});
   if(p===`/api/hybrid/pool/${pool}/positions`){
    const q=route.request().postDataJSON();assert.ok(q.claims.length<=30);
    return route.fulfill({json:{schema:'flurbo.hybrid-portfolio-positions.v1',owner:q.owner,snapshot,resolved:true,rows:q.claims.map((c:any)=>({scope:c.scope,mask:c.mask,quantity:q.owner===agent&&executions.some(e=>e.scope===c.scope&&e.mask===c.mask)?'1000000':q.owner===owner&&c.scope===1&&c.mask==='2'?'2000000':'0',payoutAtoms:q.owner===agent&&executions.some(e=>e.scope===c.scope&&e.mask===c.mask)?'1000000':'0'}))}});
   }
   if(p===`/api/hybrid/pool/${pool}/collected-payouts`)return route.fulfill({json:{complete:true,logs:[]}});
   if(p===`/api/hybrid/pool/${pool}/history`)return route.fulfill({json:{complete:indexed,logs:indexed?executions.map((e,i)=>({name:'Traded',hash:e.hash,block:e.block,index:4+i,args:{trader:agent,scope:e.scope,mask:e.mask,quantity:e.quantity,collateralAmount:e.cash,isBuy:true}})):[]}});
   if(p.startsWith('/api/'))return route.fulfill({status:503,json:{error:'Unused'}});
   const file=p.startsWith('/assets/')?p.slice(1):'index.html';return route.fulfill({body:await readFile(new URL('../dist/'+file,import.meta.url)),contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});
  });
  await page.goto('https://flurbo.singu.online/portfolio');await page.getByRole('button',{name:'Holdings · 3',exact:true}).waitFor();
  assert.equal(await page.getByRole('link',{name:'Via Rust October E2E',exact:true}).count(),2);
  // The member's own 2 shares and the agent's 1 share of the same prediction are separate rows, never one row of 3.
  const holdings=await page.locator('.unified-holdings tbody tr').evaluateAll((trs:any[])=>trs.map(tr=>({shares:tr.querySelector('td.num').lastChild.textContent.trim(),agent:!!tr.querySelector('.portfolio-agent-label')})));
  assert.deepEqual(holdings.map(h=>`${h.shares}:${h.agent}`).sort(),['1:true','1:true','2:false'],'own and agent holdings stay in separate rows');
  assert.equal(await page.getByRole('button',{name:'Collect payout',exact:true}).count(),0,'agent wallet cannot enter manual payout signer flow');
  await page.getByText('Agent wallet payouts must be collected by that wallet through its agent runtime.').waitFor();
  await page.getByRole('button',{name:'Activity',exact:true}).click();assert.equal(await page.locator('.portfolio-activity tbody tr').count(),2);
  assert.match(await page.locator('.portfolio-activity').innerText(),/-0.656981/);assert.match(await page.locator('.portfolio-activity').innerText(),/-0.345338/);
  indexed=true;await page.getByRole('button',{name:'Refresh',exact:true}).waitFor();await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.getByText('Indexed activity',{exact:true}).waitFor();
  assert.equal(await page.locator('.portfolio-activity tbody tr').count(),2,'receipt seed and history logs never double count');
  assert.equal(await page.getByRole('link',{name:'Via Rust October E2E',exact:true}).count(),2);
  await page.reload();await page.getByRole('button',{name:'Holdings · 3',exact:true}).waitFor();
  await mkdir(new URL('../../../target/agent-portfolio/',import.meta.url),{recursive:true});
  for(const width of [1440,390]){await page.setViewportSize({width,height:1000});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:new URL(`../../../target/agent-portfolio/holdings-${width}.png`,import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1'),fullPage:true});}
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
