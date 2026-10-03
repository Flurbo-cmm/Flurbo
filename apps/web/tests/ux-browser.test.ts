import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile,mkdir} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {pilotFixture,owner,hash} from './pilot-fixture.ts';
import {setup,alice,origin} from './agent-fixture.ts';

async function asset(route:any,path:string){
  const file=path.startsWith('/assets/')?path.slice(1):'index.html';
  return route.fulfill({body:await readFile(new URL('../dist/'+file,import.meta.url)),contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.woff2')?'font/woff2':'text/html'});
}

test('closed markets show settlement, aggregate manual and agent shares, and disclose evidence safely',{skip:!process.env.FLURBO_TEST_PLAYWRIGHT},async()=>{
  const {chromium}=await import(pathToFileURL(process.env.FLURBO_TEST_PLAYWRIGHT!).href),browser=await chromium.launch({headless:true,executablePath:process.env.FLURBO_TEST_BROWSER});
  const f=pilotFixture(Math.floor(Date.now()/1000),4),agent='0x'+'88'.repeat(20),errors:string[]=[];
  // Practice collections are addressed by pool; this mode keeps the real-event wording.
  f.manifest.publication.mode='deterministic-source-v1';
  f.manifest.publication.draft.closesAt=Math.floor(Date.now()/1000)-10;
  let prepares=0,evidenceReads=0,hostile=false;
  try{
    const page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',(e:Error)=>errors.push(e.message));
    await page.route('**/*',async(route:any)=>{
      const p=new URL(route.request().url()).pathname;
      if(p==='/api/auth/session')return route.fulfill({json:{session:{address:alice,method:'passkey',expiresAt:Date.now()+3600000}}});
      if(p==='/api/account/access')return route.fulfill({json:{approved:true}});
      if(p==='/api/account/wallets')return route.fulfill({json:{account:alice,wallets:[owner]}});
      if(p==='/api/account/portfolio-sources')return route.fulfill({json:{account:alice,wallets:[owner],agentWallets:[agent,owner]}});
      if(p==='/api/market-directory')return route.fulfill({json:{schema:'flurbo.market-directory.v1',markets:[{namespace:'practice-2222222222222222222222222222222222222222',label:'Closed fixture',pool:f.manifest.pool,closesAt:f.manifest.publication.draft.closesAt}]}});
      if(p==='/api/practice-2222222222222222222222222222222222222222/status'){const state=await f.service.status();return route.fulfill({json:{...state,resolved:true,cases:state.cases.map((c:any)=>({...c,phase:3,result:2,proposal:2,evidenceHash:hash}))}});}
      if(p==='/api/practice-2222222222222222222222222222222222222222/markets')return route.fulfill({json:{...await f.service.markets(),open:false,resolved:true}});
      if(p==='/api/practice-2222222222222222222222222222222222222222/positions'){const q=route.request().postDataJSON();return route.fulfill({json:{rows:q.claims.map((c:any)=>({...c,quantity:c.mask==='2'?(q.owner===agent?'5000000':'3000000'):'0',payoutAtoms:'0'}))}});}
      if(p==='/api/practice-2222222222222222222222222222222222222222/prepare'){prepares++;return route.fulfill({status:400,json:{error:'Closed'}});}
      if(p.includes('/evidence/')){evidenceReads++;return route.fulfill({json:{outcome:2,statement:'<img src=x onerror=alert(1)> is plain evidence text.',sourceURL:hostile?'javascript:alert(1)':'https://ethereum.org/',attachment:''}});}
      if(p.startsWith('/api/'))return route.fulfill({status:503,json:{error:'Unused fixture'}});
      return asset(route,p);
    });
    await page.goto(origin+'/markets/practice-2222222222222222222222222222222222222222/0');
    await page.locator('.closed-ticket').waitFor();
    await page.getByRole('region',{name:'Your position',exact:true}).getByText('8 shares',{exact:true}).waitFor();
    assert.equal(await page.getByLabel('Shares',{exact:true}).count(),0);
    assert.equal(await page.getByRole('button',{name:/Buy.*shares|Allow payment|Connect MetaMask/}).count(),0);
    assert.equal(prepares,0);assert.equal(evidenceReads,0);
    await page.getByText('Read proposed answer evidence',{exact:true}).click();
    await page.locator('.evidence-disclosure').getByText('Proposed answer: Yes',{exact:true}).waitFor();
    assert.equal(await page.locator('.evidence-disclosure img').count(),0);
    assert.equal(await page.getByRole('link',{name:'Open the original source'}).getAttribute('href'),'https://ethereum.org/');
    hostile=true;await page.getByText('Read proposed answer evidence',{exact:true}).click();await page.getByText('Read proposed answer evidence',{exact:true}).click();
    await page.locator('.evidence-disclosure').getByText('Proposed answer: Yes',{exact:true}).waitFor();
    assert.equal(await page.getByRole('link',{name:'Open the original source'}).count(),0);
    await mkdir(new URL('../../../target/ux-review/',import.meta.url),{recursive:true});
    for(const width of [1440,390]){await page.setViewportSize({width,height:950});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:new URL(`../../../target/ux-review/closed-${width}.png`,import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1'),fullPage:true});}
    assert.equal(prepares,0);assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

test('runtime setup keeps issued credentials across sections and exposes all SDKs and policy controls',{skip:!process.env.FLURBO_TEST_PLAYWRIGHT},async()=>{
  const {chromium}=await import(pathToFileURL(process.env.FLURBO_TEST_PLAYWRIGHT!).href),browser=await chromium.launch({headless:true,executablePath:process.env.FLURBO_TEST_BROWSER});
  const s=setup({at:Math.floor(Date.now()/1000)}),errors:string[]=[];
  try{
    const page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',(e:Error)=>errors.push(e.message));
    await page.route('**/*',async(route:any)=>{
      const p=new URL(route.request().url()).pathname,method=route.request().method();
      if(p==='/api/auth/session')return route.fulfill({json:{session:{address:alice,method:'passkey',expiresAt:Date.now()+3600000}}});
      if(p==='/api/account/access')return route.fulfill({json:{approved:true}});
      if(p==='/api/market-directory')return route.fulfill({json:{schema:'flurbo.market-directory.v1',markets:[{namespace:'pilot',label:'Open fixture',pool:s.f.manifest.pool,closesAt:s.f.manifest.publication.draft.closesAt}]}});
      if(p==='/api/pilot/markets')return route.fulfill({json:await s.f.service.markets()});
      if(p==='/api/agents'||p.startsWith('/api/agents/')){const result=await s.call(alice,method,p,method==='POST'?route.request().postDataJSON():undefined);return route.fulfill({status:result.status,json:result.body});}
      if(p.startsWith('/api/'))return route.fulfill({status:503,json:{error:'Unused fixture'}});
      return asset(route,p);
    });
    await page.goto(origin+'/agents');
    // The page is inert under the loading cover, so typing there is dropped. Wait for the loaded page itself
    // (agent list and market choices rendered, cover gone), not just for the cover to be absent.
    await page.waitForFunction(()=>{const root=document.querySelector('.app-root') as HTMLElement|null;return !!root&&!root.inert&&!document.querySelector('.contour-loader')&&!!document.querySelector('.agents-list')&&!document.querySelector('.agents-rows-skeleton')&&!!document.querySelector('#register-agent input[type=checkbox]');});
    const form=page.getByRole('form',{name:'Register an agent'});
    await form.getByLabel('Name',{exact:true}).fill('UX fixture agent');await form.getByRole('button',{name:'Register agent',exact:true}).click();
    await page.waitForURL(/\/agents\/[0-9a-f-]{36}$/, {timeout:15000}).catch(async()=>{throw Error(await page.locator('main').innerText());});
    await page.getByRole('button',{name:'Continue setup'}).click();
    const credentials=page.getByRole('region',{name:'API credentials'});
    await credentials.getByRole('button',{name:'Issue credential'}).click();
    await credentials.getByText('Copy this token now. It is shown once.').waitFor();
    const token=await credentials.locator('pre').innerText();assert.ok(token.length>20);
    await page.getByRole('button',{name:'Overview',exact:true}).click();assert.equal(await credentials.isVisible(),false);
    await page.getByRole('button',{name:'Setup',exact:true}).click();assert.equal(await credentials.locator('pre').innerText(),token);
    const run=page.getByRole('region',{name:'Run the agent'});
    for(const language of ['TypeScript','Python','Rust','C++']){await run.getByRole('tab',{name:language,exact:true}).click();assert.match(await run.locator('pre').innerText(),/mode.*paper/);assert.equal(await run.getByRole('button',{name:'Copy commands'}).isEnabled(),true);}
    await page.getByRole('button',{name:'Settings',exact:true}).click();
    await page.getByRole('button',{name:'Pause new actions'}).click();await page.getByRole('button',{name:'Resume new actions'}).waitFor();
    assert.equal(await page.getByRole('button',{name:'Allow live testnet trades'}).isVisible(),true);
    await page.getByRole('button',{name:'Activity',exact:true}).click();await page.getByText('No decisions yet. Start the agent in paper mode from Setup.').waitFor();
    await page.getByRole('button',{name:'Setup',exact:true}).click();await credentials.getByRole('button',{name:'I have stored it'}).click();
    await mkdir(new URL('../../../target/ux-review/',import.meta.url),{recursive:true});
    for(const width of [1440,390]){await page.setViewportSize({width,height:950});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:new URL(`../../../target/ux-review/agent-${width}.png`,import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1'),fullPage:true});}
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
