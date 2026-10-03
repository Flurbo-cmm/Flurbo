import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { pilotFixture, hash, owner } from './pilot-fixture.ts';
import { certifiedPair } from '../server/pair-math.mjs';
import { simulatePairPurchase } from '../server/pair-sensitivity.mjs';

test('What-if stays read-only, replaces pending pairs, expires snapshots and fits mobile',{skip:!process.env.FLURBO_TEST_PLAYWRIGHT},async()=>{
  const {chromium}=await import(pathToFileURL(process.env.FLURBO_TEST_PLAYWRIGHT!).href);
  const browser=await chromium.launch({headless:true,executablePath:process.env.FLURBO_TEST_BROWSER});
  const now=Math.floor(Date.now()/1000),f=pilotFixture(now,4),errors:string[]=[],requests:any[]=[];
  // Practice collections are addressed by pool; this mode keeps the real-event wording.
  f.manifest.publication.mode='deterministic-source-v1';
  let delay=false,unavailable=false,badSensitivity=false,quoteUnavailable=false,release!:()=>void;
  const held=new Promise<void>(r=>{release=r;});
  const response=(a:number,b:number)=>{
    const state={events:4,a,b,liquidity:'10000000',order:[0,1,2,3],factors:[{scope:3,values:['0','0','0','10000000']}]};
    return {schema:'flurbo.pair-analytics.v1',model:'factored-lmsr-pair-v1',chainId:10143,pool:f.manifest.pool,rulesHash:f.manifest.rulesHash,
    snapshot:{blockNumber:'100',blockHash:hash,timestamp:now},expiresAt:now+60,stateDigest:'a'.repeat(64),a,b,unit:'tenths_of_percentage_point',closed:false,
    ...certifiedPair(state),sensitivity:{schema:'flurbo.pair-sensitivity.v1',scenarios:['yes','no'].map(answer=>{
      if(quoteUnavailable)return {answer,status:'unavailable',reason:'quote_unavailable'};
      const sim=simulatePairPurchase(state,answer);
      return {answer,status:'available',scope:sim.scope,mask:badSensitivity?99:sim.mask,quantityAtoms:sim.quantity,
        costAtoms:'250001',...certifiedPair(sim.after)};
    })}};
  };
  try{
    const page=await browser.newPage({viewport:{width:1440,height:1000}});
    page.on('pageerror',(error:Error)=>errors.push(error.message));
    await page.route('**/*',async(route:any)=>{
      const path=new URL(route.request().url()).pathname;
      if(path==='/api/market-directory')return route.fulfill({json:{schema:'flurbo.market-directory.v1',active:'practice-2222222222222222222222222222222222222222',markets:[{namespace:'practice-2222222222222222222222222222222222222222',label:'September practice',pool:f.manifest.pool,closesAt:f.manifest.publication.draft.closesAt}]}});
      if(path==='/api/account/access')return route.fulfill({json:{approved:true,testingTools:false}});
      if(path==='/api/auth/session')return route.fulfill({json:{session:{address:owner,method:'passkey',expiresAt:Date.now()+3600_000}}});
      if(path==='/api/practice-2222222222222222222222222222222222222222/status')return route.fulfill({json:await f.service.status()});
      if(path==='/api/account/wallets'||path==='/api/account/portfolio-sources')return route.fulfill({json:{account:owner,wallets:[]}});
      if(path==='/api/network')return route.fulfill({status:503,json:{error:'Offline fixture'}});
      if(path==='/api/practice-2222222222222222222222222222222222222222/price-history')return route.fulfill({status:503,json:{error:'Offline fixture'}});
      if(path==='/api/practice-2222222222222222222222222222222222222222/markets')return route.fulfill({json:await f.service.markets()});
      if(path==='/api/practice-2222222222222222222222222222222222222222/analytics'){
        const input=route.request().postDataJSON();requests.push(input);
        if(delay)await held;
        return route.fulfill(unavailable?{status:503,json:{error:'unavailable'}}:{json:response(input.a,input.b)});
      }
      if(path.startsWith('/api/')){requests.push(path);return route.fulfill({status:503,json:{error:'Unexpected API'}});}
      const relative=path.startsWith('/assets/')?path.slice(1):'index.html';
      return route.fulfill({body:await readFile(new URL('../dist/'+relative,import.meta.url)),contentType:relative.endsWith('.js')?'text/javascript':relative.endsWith('.css')?'text/css':relative.endsWith('.woff2')?'font/woff2':'text/html'});
    });
    await page.goto('https://flurbo.singu.online/markets/practice-2222222222222222222222222222222222222222/0');
    await page.getByText('Explore how these markets connect',{exact:true}).click();
    assert.equal(await page.getByRole('alert').filter({hasText:'Your account holdings could not be refreshed.'}).count(),0);
    const panel=page.locator('.what-if');
    await panel.getByRole('button',{name:'Compare these questions'}).click();
    await panel.getByText('Both Yes, together',{exact:true}).waitFor();
    assert.equal(await panel.locator('.what-if-probabilities strong').allTextContents().then((a:string[])=>a.join(',')),'65.0%,73.1%,50.0%');
    assert.equal(await panel.getByText('+5.3 pp',{exact:true}).count(),1);
    assert.equal(await panel.getByRole('button',{name:/Buy|Trade|Confirm|Connect/}).count(),0);
    await panel.getByText('Price sensitivity: what could one trade change?',{exact:true}).click();
    assert.equal(await panel.locator('.what-if-scenarios article').count(),2);
    assert.equal(await panel.getByText('0.250001 test AUSD',{exact:true}).count(),2);
    assert.equal(await panel.getByText('After 75.0%',{exact:true}).count(),1);
    assert.equal(await panel.getByText('After 71.1%',{exact:true}).count(),1);
    await panel.getByText('How to read this',{exact:true}).click();
    await panel.getByText(/does not show that one event causes another/).waitFor();
    if(process.env.FLURBO_TEST_SCREENSHOT){await panel.scrollIntoViewIfNeeded();await page.screenshot({path:process.env.FLURBO_TEST_SCREENSHOT,fullPage:true});}
    // A user can change the pair without waiting for the previous RPC read.
    delay=true;await panel.getByRole('button',{name:'Refresh comparison'}).click();
    await panel.getByRole('button',{name:'Cancel',exact:true}).waitFor();
    await panel.getByRole('combobox',{name:'Question to explore',exact:true}).click();await panel.getByRole('option').nth(2).click();
    assert.equal(await panel.getByRole('button',{name:'Compare these questions'}).isEnabled(),true);
    assert.equal(await panel.getByText('Both Yes, together',{exact:true}).count(),0);
    release();delay=false;
    await panel.getByRole('button',{name:'Compare these questions'}).click();
    await panel.getByRole('heading',{name:'Chance of Yes: Test event 3'}).waitFor();
    assert.equal(await panel.getByText('0.0 pp',{exact:true}).count(),1);
    // Swapping onto the other selection preserves a distinct pair.
    await panel.getByRole('combobox',{name:'Question to explore',exact:true}).click();await panel.getByRole('option').nth(1).click();
    assert.equal((await panel.getByRole('combobox',{name:'Suppose this question resolves'}).innerText()).trim(),'Test event 3');
    unavailable=true;await panel.getByRole('button',{name:'Compare these questions'}).click();
    await panel.getByRole('alert').waitFor();assert.equal(await panel.locator('.what-if-results').count(),0);
    unavailable=false;badSensitivity=true;await panel.getByRole('button',{name:'Compare these questions'}).click();
    await panel.getByRole('alert').waitFor();assert.equal(await panel.locator('.what-if-results').count(),0);
    badSensitivity=false;quoteUnavailable=true;await panel.getByRole('button',{name:'Compare these questions'}).click();
    await panel.locator('.what-if-results').waitFor();
    await panel.getByText('Price sensitivity: what could one trade change?',{exact:true}).click();
    assert.equal(await panel.getByText(/A contract quote is unavailable/).count(),2);
    quoteUnavailable=false;await panel.getByRole('button',{name:'Refresh comparison'}).click();
    await panel.locator('.what-if-results').waitFor();
    await panel.getByText('Price sensitivity: what could one trade change?',{exact:true}).click();
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    if(process.env.FLURBO_TEST_SCREENSHOT){await panel.scrollIntoViewIfNeeded();await page.screenshot({path:process.env.FLURBO_TEST_SCREENSHOT.replace('.png','-mobile.png'),fullPage:true});}
    await page.clock.install({time:new Date(now*1000)});await page.clock.fastForward(61_000);
    await panel.getByText(/This snapshot is over a minute old/).waitFor();assert.equal(await panel.locator('.what-if-results').count(),0);
    assert.ok(requests.every(r=>typeof r==='object'&&Object.keys(r).sort().join(',')==='a,b'));
    assert.deepEqual(errors,[]);
  }finally{release();await browser.close();}
});
