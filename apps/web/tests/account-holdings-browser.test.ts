import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {pilotFixture,owner} from './pilot-fixture.ts';

test('one Mera portfolio sums wallets, loads beyond one page of claims, and recovers a partial read',{skip:!process.env.FLURBO_TEST_PLAYWRIGHT},async()=>{
  const {chromium}=await import(pathToFileURL(process.env.FLURBO_TEST_PLAYWRIGHT!).href);
  const browser=await chromium.launch({headless:true,executablePath:process.env.FLURBO_TEST_BROWSER});
  const login='0x'+'99'.repeat(20),second='0x'+'ab'.repeat(20),fixture=pilotFixture(Math.floor(Date.now()/1000),4);
  // Practice collections are addressed by pool; this mode keeps the real-event wording.
  fixture.manifest.publication.mode='deterministic-source-v1';
  let fail=false,scans=0;const batches:any[]=[],errors:string[]=[];
  try{
    const page=await browser.newPage({viewport:{width:390,height:844}});
    page.on('pageerror',(e:Error)=>errors.push(e.message));
    await page.route('**/*',async(route:any)=>{
      const url=new URL(route.request().url()),path=url.pathname;
      if(path==='/api/account/access')return route.fulfill({json:{approved:true,testingTools:false}});
      if(path==='/api/auth/session')return route.fulfill({json:{session:{address:login,method:'passkey',expiresAt:Date.now()+3600000}}});
      if((path==='/api/account/wallets'||path==='/api/account/portfolio-sources'))return route.fulfill({json:{account:login,wallets:[owner,second]}});
      if(path==='/api/market-directory')return route.fulfill({json:{schema:'flurbo.market-directory.v1',active:'practice-2222222222222222222222222222222222222222',markets:[{namespace:'practice-2222222222222222222222222222222222222222',label:'Practice markets',pool:fixture.manifest.pool,closesAt:fixture.manifest.publication.draft.closesAt}]}});
      if(path==='/api/practice-2222222222222222222222222222222222222222/account')return route.fulfill({json:{...await fixture.service.account(url.searchParams.get('wallet')),claimScopes:[3,5,6,7,9,10,11,12,13,14]}});
      if(path==='/api/practice-2222222222222222222222222222222222222222/history'){scans++;return route.fulfill({json:{complete:true,logs:[]}});}
      if(path==='/api/practice-2222222222222222222222222222222222222222/positions'){
        const input=route.request().postDataJSON();batches.push(input);
        if(fail&&input.owner===second)return route.fulfill({status:503,json:{error:'Read failed'}});
        return route.fulfill({json:{rows:input.claims.map((c:any)=>({...c,payoutAtoms:null,quantity:
          c.scope===1&&c.mask==='2'?(input.owner===owner?'10000000':input.owner===second?'7000000':'2000000'):
          c.scope===1&&c.mask==='1'&&input.owner===second?'4000000':
          c.scope===14&&c.mask==='128'&&input.owner===owner?'3000000':'0'}))}});
      }
      if(path.startsWith('/api/'))return route.fulfill({status:503,json:{error:'Unexpected API'}});
      const relative=path.startsWith('/assets/')?path.slice(1):'index.html';
      return route.fulfill({body:await readFile(new URL('../dist/'+relative,import.meta.url)),contentType:relative.endsWith('.js')?'text/javascript':relative.endsWith('.css')?'text/css':relative.endsWith('.woff2')?'font/woff2':'text/html'});
    });
    await page.goto('https://flurbo.singu.online/portfolio');
    await page.getByRole('cell',{name:'19',exact:true}).waitFor();
    await page.getByRole('cell',{name:'4',exact:true}).waitFor();
    await page.getByText('Test event 2 + Test event 3 + Test event 4',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Refresh',exact:true}).waitFor();
    assert.equal(scans,1);assert.ok(batches.length>3);assert.ok(batches.every(b=>b.claims.length<=60));
    assert.equal(await page.locator('.portfolio-account-identity').getByText(login,{exact:true}).count(),1);
    assert.equal(await page.getByRole('heading',{name:'Your shares',exact:true}).count(),1);
    assert.equal(await page.getByRole('table').count(),1);
    assert.equal(await page.getByRole('button',{name:'Refresh',exact:true}).count(),1);
    assert.equal(await page.getByRole('textbox').count(),0);
    assert.doesNotMatch(await page.locator('body').innerText(),/All wallets|Earlier Mera holdings|Wallet 0x|Continue loading/);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    if(process.env.FLURBO_TEST_SCREENSHOT)await page.screenshot({path:process.env.FLURBO_TEST_SCREENSHOT,fullPage:true});
    await page.setViewportSize({width:1440,height:1000});
    if(process.env.FLURBO_TEST_SCREENSHOT)await page.screenshot({path:process.env.FLURBO_TEST_SCREENSHOT.replace('.png','-desktop.png'),fullPage:true});
    fail=true;await page.getByRole('button',{name:'Refresh',exact:true}).click();
    await page.getByRole('alert').filter({hasText:'Some shares'}).waitFor();
    await page.getByRole('button',{name:'Refresh',exact:true}).waitFor();
    await page.getByRole('cell',{name:'12',exact:true}).waitFor();
    assert.equal(await page.getByRole('cell',{name:'19',exact:true}).count(),0);
    fail=false;await page.getByRole('button',{name:'Refresh',exact:true}).click();
    await page.getByRole('cell',{name:'19',exact:true}).waitFor();
    assert.equal(await page.getByRole('alert').count(),0);assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

test('a returning member sees their last holdings at once, labelled, while fresh balances load',{skip:!process.env.FLURBO_TEST_PLAYWRIGHT},async()=>{
  const {chromium}=await import(pathToFileURL(process.env.FLURBO_TEST_PLAYWRIGHT!).href);
  const browser=await chromium.launch({headless:true,executablePath:process.env.FLURBO_TEST_BROWSER});
  const login='0x'+'99'.repeat(20),second='0x'+'ab'.repeat(20),fixture=pilotFixture(Math.floor(Date.now()/1000),4);
  fixture.manifest.publication.mode='deterministic-source-v1';
  let fail=false,scans=0;const batches:any[]=[],errors:string[]=[];
  let gate:Promise<void>=Promise.resolve(),release=()=>{};
  try{
    const page=await browser.newPage({viewport:{width:390,height:844}});
    page.on('pageerror',(e:Error)=>errors.push(e.message));
    await page.route('**/*',async(route:any)=>{
      const url=new URL(route.request().url()),path=url.pathname;
      if(path==='/api/account/access')return route.fulfill({json:{approved:true,testingTools:false}});
      if(path==='/api/auth/session')return route.fulfill({json:{session:{address:login,method:'passkey',expiresAt:Date.now()+3600000}}});
      if((path==='/api/account/wallets'||path==='/api/account/portfolio-sources'))return route.fulfill({json:{account:login,wallets:[owner,second]}});
      if(path==='/api/market-directory')return route.fulfill({json:{schema:'flurbo.market-directory.v1',active:'practice-2222222222222222222222222222222222222222',markets:[{namespace:'practice-2222222222222222222222222222222222222222',label:'Practice markets',pool:fixture.manifest.pool,closesAt:fixture.manifest.publication.draft.closesAt}]}});
      if(path==='/api/practice-2222222222222222222222222222222222222222/account')return route.fulfill({json:{...await fixture.service.account(url.searchParams.get('wallet')),claimScopes:[3,5,6,7,9,10,11,12,13,14]}});
      if(path==='/api/practice-2222222222222222222222222222222222222222/history'){scans++;return route.fulfill({json:{complete:true,logs:[]}});}
      if(path==='/api/practice-2222222222222222222222222222222222222222/positions'){
        const input=route.request().postDataJSON();batches.push(input);await gate;
        if(fail&&input.owner===second)return route.fulfill({status:503,json:{error:'Read failed'}});
        return route.fulfill({json:{rows:input.claims.map((c:any)=>({...c,payoutAtoms:null,quantity:
          c.scope===1&&c.mask==='2'?(input.owner===owner?'10000000':input.owner===second?'7000000':'2000000'):
          c.scope===1&&c.mask==='1'&&input.owner===second?'4000000':
          c.scope===14&&c.mask==='128'&&input.owner===owner?'3000000':'0'}))}});
      }
      if(path.startsWith('/api/'))return route.fulfill({status:503,json:{error:'Unexpected API'}});
      const relative=path.startsWith('/assets/')?path.slice(1):'index.html';
      return route.fulfill({body:await readFile(new URL('../dist/'+relative,import.meta.url)),contentType:relative.endsWith('.js')?'text/javascript':relative.endsWith('.css')?'text/css':relative.endsWith('.woff2')?'font/woff2':'text/html'});
    });
    await page.goto('https://flurbo.singu.online/portfolio');
    await page.getByRole('cell',{name:'19',exact:true}).waitFor();
    await page.getByRole('button',{name:'Refresh',exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>Object.keys(localStorage).some(k=>k.startsWith('flurbo.portfolio-cache.v1:'))),true);
    // Second visit: holdings reads are held back, yet the last holdings show immediately and are labelled.
    gate=new Promise<void>(r=>{release=r;});
    await page.reload();
    await page.getByRole('cell',{name:'19',exact:true}).waitFor({timeout:5000});
    await page.getByText(/Showing your holdings from/).waitFor();
    assert.equal(await page.getByRole('button',{name:'Collect payout'}).count(),0);
    release();
    await page.getByRole('button',{name:'Refresh',exact:true}).waitFor();
    assert.equal(await page.getByText(/Showing your holdings from/).count(),0);
    await page.getByRole('cell',{name:'19',exact:true}).waitFor();
    void fail;void scans;assert.deepEqual(errors,[]);
  }finally{release();await browser.close();}
});
