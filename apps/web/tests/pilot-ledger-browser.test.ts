import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { pilotFixture, owner, hash } from './pilot-fixture.ts';

test('combined shares appear in a fresh browser before history responds, with no saved trade hints',{skip:!process.env.FLURBO_TEST_PLAYWRIGHT},async()=>{
  const {chromium}=await import(pathToFileURL(process.env.FLURBO_TEST_PLAYWRIGHT!).href);
  const browser=await chromium.launch({headless:true,executablePath:process.env.FLURBO_TEST_BROWSER});
  const f=pilotFixture(Math.floor(Date.now()/1000),4),login='0x'+'99'.repeat(20),errors:string[]=[],batches:any[]=[];
  // Practice collections are addressed by pool; this mode keeps the real-event wording.
  f.manifest.publication.mode='deterministic-source-v1';
  let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
  try{
    const page=await browser.newPage({viewport:{width:390,height:844}});
    page.on('pageerror',(e:Error)=>errors.push(e.message));
    await page.addInitScript(({login,owner}:any)=>{sessionStorage.setItem('flurbo.view-wallet:'+login,owner);},{login,owner});
    await page.route('**/*',async(route:any)=>{
      const url=new URL(route.request().url()),path=url.pathname;
      if(path==='/api/market-directory')return route.fulfill({json:{schema:'flurbo.market-directory.v1',active:'practice-2222222222222222222222222222222222222222',markets:[{namespace:'practice-2222222222222222222222222222222222222222',label:'September practice',pool:f.manifest.pool,closesAt:f.manifest.publication.draft.closesAt}]}});
      if(path==='/api/account/wallets'||path==='/api/account/portfolio-sources')return route.fulfill({json:{account:login,wallets:[owner]}});
      if(path==='/api/account/access')return route.fulfill({json:{approved:true,testingTools:false}});
      if(path==='/api/auth/session')return route.fulfill({json:{session:{address:login,method:'passkey',expiresAt:Date.now()+3600000}}});
      if(path==='/api/practice-2222222222222222222222222222222222222222/account')return route.fulfill({json:{...await f.service.account(url.searchParams.get('wallet')),claimScopes:[1,2,3]}});
      if(path==='/api/practice-2222222222222222222222222222222222222222/history'){await gate;return route.fulfill({status:503,json:{error:'History unavailable'}}).catch(()=>{});}
      if(path==='/api/practice-2222222222222222222222222222222222222222/positions'){
        const input=route.request().postDataJSON();batches.push(input);
        return route.fulfill({json:{snapshot:{blockNumber:'200'},rows:input.claims.map((c:any)=>({...c,quantity:input.owner===owner&&c.scope===3&&c.mask==='8'?'10000000':'0',payoutAtoms:null}))}});
      }
      if(path.startsWith('/api/'))return route.fulfill({status:503,json:{error:'Unexpected API'}});
      const relative=path.startsWith('/assets/')?path.slice(1):'index.html';
      return route.fulfill({body:await readFile(new URL('../dist/'+relative,import.meta.url)),contentType:relative.endsWith('.js')?'text/javascript':relative.endsWith('.css')?'text/css':relative.endsWith('.woff2')?'font/woff2':'text/html'});
    });
    await page.goto('https://flurbo.singu.online/portfolio');
    const combined=page.getByRole('cell').filter({has:page.getByText('Test event 1 + Test event 2',{exact:true})});
    await combined.locator('strong').getByText('Test event 1 + Test event 2',{exact:true}).waitFor();
    await combined.locator('small').getByText('Yes AND Yes',{exact:true}).waitFor();
    await page.getByRole('cell',{name:'10',exact:true}).waitFor();
    assert.equal(batches.length,2);assert.ok(batches.every(b=>b.claims.length===18));
    // Four binary questions plus every named two-question claim, including XOR.
    assert.deepEqual(batches.map(b=>b.owner).sort(),[login,owner].sort());
    for(const batch of batches)for(const mask of ['6','8','9'])assert.ok(batch.claims.some((c:any)=>c.scope===3&&c.mask===mask));
    assert.equal(await page.getByRole('button',{name:/^Refresh/}).count(),1);
    // No trade hints are saved or needed; the only entry is the holdings cache for the next visit.
    assert.deepEqual(await page.evaluate(()=>Object.keys(localStorage).filter(k=>!k.startsWith('flurbo.portfolio-cache.v1:'))),[]);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    assert.equal(await page.locator('.portfolio-account-identity').getByText(login,{exact:true}).count(),1);
    assert.equal(await page.getByRole('textbox',{name:'Wallet to view'}).count(),0);
    release();assert.deepEqual(errors,[]);
  }finally{release();await browser.close();}
});

test('account portfolio discovers older combinations on refresh and stops scanning after a history error',{skip:!process.env.FLURBO_TEST_PLAYWRIGHT},async()=>{
  const {chromium}=await import(pathToFileURL(process.env.FLURBO_TEST_PLAYWRIGHT!).href);
  const browser=await chromium.launch({headless:true,executablePath:process.env.FLURBO_TEST_BROWSER});
  const fixture=pilotFixture();let scans=0,fail=false;
  const login='0x'+'99'.repeat(20),errors:string[]=[];
  try{
    const page=await browser.newPage({viewport:{width:390,height:844}});
    await page.clock.install();await page.clock.pauseAt(new Date());
    page.on('pageerror',(e:Error)=>errors.push(e.message));
    await page.addInitScript(({login,owner}:any)=>{sessionStorage.setItem('flurbo.trading.market','pilot');sessionStorage.setItem('flurbo.view-wallet:'+login,owner);},{login,owner});
    await page.route('**/*',async(route:any)=>{
      const path=new URL(route.request().url()).pathname;
      if(path==='/api/market-directory')return route.fulfill({json:{schema:'flurbo.market-directory.v1',active:'practice-2222222222222222222222222222222222222222',markets:[{namespace:'pilot',label:'Earlier real-event markets',pool:fixture.manifest.pool,closesAt:fixture.manifest.publication.draft.closesAt}]}});
      if(path==='/api/account/wallets'||path==='/api/account/portfolio-sources')return route.fulfill({json:{account:login,wallets:[owner]}});
      if(path==='/api/account/access')return route.fulfill({json:{approved:true,testingTools:false}});
      if(path==='/api/auth/session')return route.fulfill({json:{session:{address:login,method:'passkey',expiresAt:Date.now()+3600000}}});
      if(path==='/api/pilot/account')return route.fulfill({json:await fixture.service.account(owner)});
      if(path==='/api/pilot/history'){
        scans++;if(fail)return route.fulfill({status:503,json:{error:'Index service interrupted'}});
        return route.fulfill({json:{through:scans===1?100:200,target:200,complete:scans>1,logs:scans===1?[]:[{name:'Traded',hash,index:0,block:150,args:{trader:owner,scope:3,mask:'8',isBuy:true}}]}});
      }
      if(path==='/api/pilot/positions')return route.fulfill({json:{rows:route.request().postDataJSON().claims.map((c:any)=>({...c,quantity:c.scope===3?'1000000':'0',payoutAtoms:null}))}});
      if(path.startsWith('/api/'))return route.fulfill({status:503,json:{error:'Fixture service unavailable'}});
      const relative=path.startsWith('/assets/')?path.slice(1):'index.html';
      return route.fulfill({body:await readFile(new URL('../dist/'+relative,import.meta.url)),contentType:relative.endsWith('.js')?'text/javascript':relative.endsWith('.css')?'text/css':relative.endsWith('.woff2')?'font/woff2':'text/html'});
    });
    await page.goto('https://flurbo.singu.online/portfolio');
    await page.getByRole('button',{name:'Refresh',exact:true}).waitFor();
    assert.equal(scans,1);
    await page.getByRole('button',{name:'Refresh',exact:true}).click();
    await page.getByText('Test event 1 + Test event 2',{exact:true}).waitFor();
    assert.equal(scans,2);
    assert.equal(await page.locator('.portfolio-account-identity').getByText(login,{exact:true}).count(),1);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    fail=true;await page.getByRole('button',{name:'Refresh',exact:true}).click();
    await page.getByText('Earlier activity is still being verified. Current holdings and collected payouts remain available.',{exact:true}).waitFor();
    assert.equal(await page.getByRole('link',{name:'Check history'}).count(),0);
    const stopped=scans;await page.clock.runFor(6500);assert.equal(scans,stopped,'a history error must stop background catch-up');
    fail=false;await page.getByRole('button',{name:'Refresh',exact:true}).click();
    await page.getByText('Test event 1 + Test event 2',{exact:true}).waitFor();
    assert.equal(scans,stopped+1);assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

test('practice history outage still shows owned shares through the retired history route; failed reads clear prior holdings',{skip:!process.env.FLURBO_TEST_PLAYWRIGHT},async()=>{
  const {chromium}=await import(pathToFileURL(process.env.FLURBO_TEST_PLAYWRIGHT!).href);
  const browser=await chromium.launch({headless:true,executablePath:process.env.FLURBO_TEST_BROWSER});
  const fixture=pilotFixture(Math.floor(Date.now()/1000),4),login='0x'+'99'.repeat(20);
  // Practice collections are addressed by pool; this mode keeps the real-event wording.
  fixture.manifest.publication.mode='deterministic-source-v1';
  let failHistory=true,failAccount=false,scans=0;
  const errors:string[]=[],requests:string[]=[];
  try{
    const page=await browser.newPage({viewport:{width:390,height:844}});
    page.on('pageerror',(e:Error)=>errors.push(e.message));
    await page.addInitScript(({login,owner}:any)=>{sessionStorage.setItem('flurbo.view-wallet:'+login,owner);},{login,owner});
    await page.route('**/*',async(route:any)=>{
      const url=new URL(route.request().url()),path=url.pathname;requests.push(path);
      if(path==='/api/market-directory')return route.fulfill({json:{schema:'flurbo.market-directory.v1',active:'practice-2222222222222222222222222222222222222222',markets:[{namespace:'practice-2222222222222222222222222222222222222222',label:'September practice',pool:fixture.manifest.pool,closesAt:fixture.manifest.publication.draft.closesAt}]}});
      if(path==='/api/account/wallets'||path==='/api/account/portfolio-sources')return route.fulfill({json:{account:login,wallets:[owner]}});
      if(path==='/api/account/access')return route.fulfill({json:{approved:true,testingTools:false}});
      if(path==='/api/auth/session')return route.fulfill({json:{session:{address:login,method:'passkey',expiresAt:Date.now()+3600000}}});
      if(path==='/api/practice-2222222222222222222222222222222222222222/account')return failAccount?route.fulfill({status:503,json:{error:'Account unavailable'}}):route.fulfill({json:await fixture.service.account(url.searchParams.get('wallet'))});
      if(path==='/api/practice-2222222222222222222222222222222222222222/history'){
        scans++;if(failHistory)return route.fulfill({status:503,json:{error:'History unavailable'}});
        return route.fulfill({json:{through:200,target:200,complete:true,logs:[{name:'Traded',hash,index:0,block:150,args:{trader:owner,scope:1,mask:'2',isBuy:true,quantity:'10000000',collateralAmount:'6201146'}}]}});
      }
      if(path==='/api/practice-2222222222222222222222222222222222222222/positions'){
        const input=route.request().postDataJSON();
        return route.fulfill({json:{snapshot:{blockNumber:'200'},rows:input.claims.map((c:any)=>({...c,quantity:input.owner===owner&&c.scope===1&&c.mask==='2'?'10000000':'0',payoutAtoms:null}))}});
      }
      if(path.startsWith('/api/'))return route.fulfill({status:503,json:{error:'Unexpected API'}});
      const relative=path.startsWith('/assets/')?path.slice(1):'index.html';
      return route.fulfill({body:await readFile(new URL('../dist/'+relative,import.meta.url)),contentType:relative.endsWith('.js')?'text/javascript':relative.endsWith('.css')?'text/css':relative.endsWith('.woff2')?'font/woff2':'text/html'});
    });
    await page.goto('https://flurbo.singu.online/history');await page.waitForURL('**/portfolio');
    await page.getByRole('cell',{name:'10',exact:true}).waitFor();
    await page.getByText('Test event 1',{exact:true}).waitFor();
    await page.getByText('Earlier activity is still being verified. Current holdings and collected payouts remain available.',{exact:true}).waitFor();
    assert.doesNotMatch(await page.locator('body').innerText(),/No indexed activity|No shares in this collection yet/);
    await page.getByRole('button',{name:'Refresh',exact:true}).waitFor();
    const stopped=scans;await page.waitForTimeout(1800);assert.equal(scans,stopped);
    failHistory=false;await page.getByRole('button',{name:'Refresh',exact:true}).click();
    await page.getByRole('cell',{name:'10',exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    if(process.env.FLURBO_TEST_SCREENSHOT) await page.screenshot({path:process.env.FLURBO_TEST_SCREENSHOT,fullPage:true});
    failAccount=true;await page.getByRole('button',{name:'Refresh',exact:true}).click();
    await page.getByRole('alert').filter({hasText:'Some shares could not be refreshed.'}).waitFor();
    assert.equal(await page.getByRole('cell',{name:'10',exact:true}).count(),0);
    failAccount=false;await page.getByRole('button',{name:'Refresh',exact:true}).click();
    await page.getByRole('cell',{name:'10',exact:true}).waitFor();
    assert.deepEqual(errors,[]);assert.ok(requests.every(p=>!p.endsWith('/prepare')&&!p.endsWith('/rpc')));
  }finally{await browser.close();}
});

const serveDist=async(route:any,path:string)=>{
  const relative=path.startsWith('/assets/')?path.slice(1):'index.html';
  return route.fulfill({body:await readFile(new URL('../dist/'+relative,import.meta.url)),contentType:relative.endsWith('.js')?'text/javascript':relative.endsWith('.css')?'text/css':relative.endsWith('.woff2')?'font/woff2':'text/html'});
};
const until=async(check:()=>boolean)=>{for(let n=0;!check()&&n<300;n++)await new Promise(r=>setTimeout(r,10));assert.equal(check(),true);};

test('portfolio pool isolation and linked-wallet changes survive late replies',{skip:!process.env.FLURBO_TEST_PLAYWRIGHT},async()=>{
  const {chromium}=await import(pathToFileURL(process.env.FLURBO_TEST_PLAYWRIGHT!).href);
  const browser=await chromium.launch({headless:true,executablePath:process.env.FLURBO_TEST_BROWSER});
  const fixture=pilotFixture(Math.floor(Date.now()/1000),4),login='0x'+'99'.repeat(20),second='0x'+'aa'.repeat(20),other='practice-'+'cd'.repeat(20);
  fixture.manifest.publication.mode='rehearsal';
  let linked=[owner],holdOld=true,heldOld=false,holdLinked=false,heldLinked=false,releaseOld!:()=>void,releaseLinked!:()=>void;
  const oldGate=new Promise<void>(r=>releaseOld=r),linkedGate=new Promise<void>(r=>releaseLinked=r),errors:string[]=[];
  try{
    const page=await browser.newPage({viewport:{width:390,height:844}});
    page.on('pageerror',(e:Error)=>errors.push(e.message));
    await page.addInitScript(({login,owner}:any)=>{
      sessionStorage.setItem('flurbo.view-wallet:'+login,owner);
      // Deliver late replies despite cancellation, so the stale-result guard is exercised, not only fetch abort.
      const original=window.fetch;(window as any).cancelledReads=0;
      window.fetch=(input,options)=>{
        if(/^\/api\/practice-/.test(String(input))){
          options?.signal?.addEventListener('abort',()=>{(window as any).cancelledReads++;},{once:true});
          return original(input,{...options,signal:undefined});
        }
        return original(input,options);
      };
    },{login,owner});
    await page.route('**/*',async(route:any)=>{
      const url=new URL(route.request().url()),path=url.pathname,namespace=path.split('/')[2];
      if(path==='/api/market-directory')return route.fulfill({json:{schema:'flurbo.market-directory.v1',active:'practice-2222222222222222222222222222222222222222',markets:[
        {namespace:'practice-2222222222222222222222222222222222222222',label:'September practice',pool:fixture.manifest.pool,closesAt:fixture.manifest.publication.draft.closesAt},
        {namespace:other,label:'October practice',pool:'0x'+'cd'.repeat(20),closesAt:fixture.manifest.publication.draft.closesAt}]}});
      if(path==='/api/account/wallets'||path==='/api/account/portfolio-sources')return route.fulfill({json:{account:login,wallets:linked}});
      if(path==='/api/account/access')return route.fulfill({json:{approved:true,testingTools:false}});
      if(path==='/api/auth/session')return route.fulfill({json:{session:{address:login,method:'passkey',expiresAt:Date.now()+3600000}}});
      if(path.endsWith('/account')){const account=await fixture.service.account(url.searchParams.get('wallet'));return route.fulfill({json:namespace===other?{...account,manifest:{...account.manifest,pool:'0x'+'cd'.repeat(20)}}:account});}
      if(path.endsWith('/history'))return route.fulfill({json:{through:200,target:200,complete:true,logs:[]}});
      if(path.endsWith('/positions')){
        const input=route.request().postDataJSON();let quantity='0';
        if(namespace==='practice-2222222222222222222222222222222222222222'&&input.owner===owner){if(holdOld){heldOld=true;await oldGate;}quantity='10000000';}
        else if(namespace===other&&input.owner===owner){if(holdLinked){heldLinked=true;await linkedGate;quantity='10000000';}else quantity='3000000';}
        else if(namespace===other&&input.owner===second)quantity='5000000';
        return route.fulfill({json:{snapshot:{blockNumber:'200'},rows:input.claims.map((c:any)=>({...c,quantity:c.scope===1&&c.mask==='2'?quantity:'0',payoutAtoms:null}))}}).catch(()=>{});
      }
      if(path.startsWith('/api/'))return route.fulfill({status:503,json:{error:'Unexpected API'}});
      return serveDist(route,path);
    });
    await page.goto('https://flurbo.singu.online/portfolio');
    await until(()=>heldOld);
    // Both pools share a table but quantities must never merge across pool IDs.
    const october=page.getByRole('row').filter({has:page.locator(`a[href="/markets/${other}/0"]`)});
    await page.getByRole('cell',{name:'3',exact:true}).waitFor();
    releaseOld();await page.waitForTimeout(300);
    assert.equal(await october.getByRole('cell',{name:'10',exact:true}).count(),0);
    assert.equal(await october.getByRole('cell',{name:'3',exact:true}).count(),1);
    // A wallet linked while a read is pending replaces the account view; the older read cannot land afterwards.
    holdLinked=true;await page.getByRole('button',{name:'Refresh',exact:true}).click();await until(()=>heldLinked);
    holdLinked=false;linked=[owner,second];await page.evaluate(()=>window.dispatchEvent(new Event('flurbo:wallet-linked')));
    await page.getByRole('cell',{name:'8',exact:true}).waitFor();
    releaseLinked();await page.waitForTimeout(300);
    assert.equal(await page.getByRole('cell',{name:'8',exact:true}).count(),1);
    assert.equal(await october.getByRole('cell',{name:/^(10|13|18)$/}).count(),0);
    assert.ok(await page.evaluate(()=>(window as any).cancelledReads)>=2);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    assert.deepEqual(errors,[]);
  }finally{releaseOld();releaseLinked();await browser.close();}
});

test('portfolio shares one discovery read across linked wallets, bounds reads and batches, and cancels work on leaving',{skip:!process.env.FLURBO_TEST_PLAYWRIGHT},async()=>{
  const {chromium}=await import(pathToFileURL(process.env.FLURBO_TEST_PLAYWRIGHT!).href);
  const browser=await chromium.launch({headless:true,executablePath:process.env.FLURBO_TEST_BROWSER});
  const fixture=pilotFixture(Math.floor(Date.now()/1000),4),login='0x'+'99'.repeat(20),wallets=[owner,'0x'+'aa'.repeat(20),'0x'+'bb'.repeat(20)];
  // Practice collections are addressed by pool; this mode keeps the real-event wording.
  fixture.manifest.publication.mode='deterministic-source-v1';
  let scans=0,active=0,peak=0,hold=false,held=false,release!:()=>void;const gate=new Promise<void>(r=>release=r);
  const batches:number[]=[],errors:string[]=[];
  try{
    const page=await browser.newPage({viewport:{width:1280,height:900}});
    await page.clock.install();await page.clock.pauseAt(new Date());
    page.on('pageerror',(e:Error)=>errors.push(e.message));
    await page.addInitScript(()=>{
      const original=window.fetch;(window as any).cancelledReads=0;
      window.fetch=(input,options)=>{options?.signal?.addEventListener('abort',()=>{(window as any).cancelledReads++;},{once:true});return original(input,options);};
    });
    await page.route('**/*',async(route:any)=>{
      const url=new URL(route.request().url()),path=url.pathname;
      if(path==='/api/market-directory')return route.fulfill({json:{schema:'flurbo.market-directory.v1',active:'practice-2222222222222222222222222222222222222222',markets:[{namespace:'practice-2222222222222222222222222222222222222222',label:'September practice',pool:fixture.manifest.pool,closesAt:fixture.manifest.publication.draft.closesAt}]}});
      if(path==='/api/account/wallets'||path==='/api/account/portfolio-sources')return route.fulfill({json:{account:login,wallets}});
      if(path==='/api/account/access')return route.fulfill({json:{approved:true,testingTools:false}});
      if(path==='/api/auth/session')return route.fulfill({json:{session:{address:login,method:'passkey',expiresAt:Date.now()+3600000}}});
      if(path==='/api/practice-2222222222222222222222222222222222222222/history'){scans++;return route.fulfill({json:{through:150,target:200,complete:false,logs:[]}});}
      if(path==='/api/practice-2222222222222222222222222222222222222222/account'||path==='/api/practice-2222222222222222222222222222222222222222/positions'){
        active++;peak=Math.max(peak,active);
        try{
          await new Promise(r=>setTimeout(r,60));
          if(path.endsWith('/account'))return await route.fulfill({json:{...await fixture.service.account(url.searchParams.get('wallet')),claimScopes:[1,2,3]}}).catch(()=>{});
          const input=route.request().postDataJSON();batches.push(input.claims.length);
          if(hold){held=true;await gate;}
          return await route.fulfill({json:{snapshot:{blockNumber:'200'},rows:input.claims.map((c:any)=>({...c,quantity:c.scope===1&&c.mask==='2'?'1000000':'0',payoutAtoms:null}))}}).catch(()=>{});
        }finally{active--;}
      }
      if(path.startsWith('/api/'))return route.fulfill({status:503,json:{error:'Unexpected API'}});
      return serveDist(route,path);
    });
    await page.goto('https://flurbo.singu.online/portfolio');
    // Three linked wallets plus the Mera account each hold one share of the same claim, combined into one row.
    await page.getByRole('cell',{name:'4',exact:true}).waitFor();
    await page.getByText('Earlier activity is still being verified. Current holdings and collected payouts remain available.',{exact:true}).waitFor();
    assert.equal(scans,1,'one shared discovery read, not one per wallet');
    assert.ok(peak<=4,`at most four concurrent holdings reads (two pools, two wallets each), saw ${peak}`);
    assert.ok(batches.length>0&&batches.every(n=>n>0&&n<=60),`position batches exceed sixty claims: ${batches}`);
    await page.clock.runFor(3100);
    await page.getByRole('button',{name:'Refresh',exact:true}).waitFor();
    assert.equal(scans,2,'one bounded history catch-up is allowed');
    await page.clock.runFor(6500);assert.equal(scans,2,'unchanged index progress must stop automatic catch-up');
    const scansBeforeRefresh=scans;
    hold=true;await page.getByRole('button',{name:'Refresh',exact:true}).click();await until(()=>held);
    assert.equal(scans,scansBeforeRefresh,'history must wait for initial holdings, including on refresh');
    const cancelled=await page.evaluate(()=>(window as any).cancelledReads);
    await page.getByRole('link',{name:'Markets',exact:true}).first().click();await page.waitForURL('**/markets');
    assert.ok(await page.evaluate(()=>(window as any).cancelledReads)>cancelled,'leaving Portfolio cancels pending reads');
    release();await page.waitForTimeout(300);
    assert.equal(scans,scansBeforeRefresh);assert.equal(await page.locator('.unified-portfolio').count(),0);
    assert.deepEqual(errors,[]);
  }finally{release();await browser.close();}
});
