import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {pilotFixture,hash,owner} from './pilot-fixture.ts';
import {thesisCandidates} from '../shared/thesis.mjs';

test('thesis browser: visible rules before quotes, private forecast, one bounded comparison, expiry, mobile, and exact trade-ticket handoff',{skip:!process.env.FLURBO_TEST_PLAYWRIGHT},async()=>{
  const {chromium}=await import(pathToFileURL(process.env.FLURBO_TEST_PLAYWRIGHT!).href);
  const browser=await chromium.launch({headless:true,executablePath:process.env.FLURBO_TEST_BROWSER});
  const f=pilotFixture(Math.floor(Date.now()/1000),4),errors:string[]=[],requests:any[]=[];
  // Practice collections are addressed by pool; this mode keeps the real-event wording.
  f.manifest.publication.mode='deterministic-source-v1';
  let closed=false,delay=false,fail=false,release=()=>{};
  const response=(input:any)=>{
    const time=Math.floor(Date.now()/1000);
    return {schema:'flurbo.thesis.v1',chainId:10143,pool:f.manifest.pool,rulesHash:f.manifest.rulesHash,input,eventIds:[`event-${input.a}`,`event-${input.b}`],snapshot:{blockNumber:'100',blockHash:hash,timestamp:time},expiresAt:time+60,stateDigest:'a'.repeat(64),closed,resolved:closed,unit:'tenths_of_percentage_point',maxTradeQuantityAtoms:'10000000',
      pair:{values:{a:500,b:500,joint:250,givenYes:500,givenNo:500,independent:250,difference:0},reasons:{}},scenarios:[250,250,250,250],
      candidates:thesisCandidates(4,input.a,input.b,input.yesA,input.yesB).map((c,i)=>{
        const cost=BigInt(input.quantity)*BigInt([52,26,76,52][i])/100n;
        return {...c,probability:[500,250,750,500][i],costAtoms:closed?null:String(cost),maxSpendAtoms:closed?null:String((cost*10050n+9999n)/10000n),reason:closed?'market_closed':null};
      })};
  };
  try{
    const page=await browser.newPage({viewport:{width:1440,height:1000}});
    page.on('pageerror',(e:Error)=>errors.push(e.message));page.on('dialog',(d:any)=>d.accept());
    await page.route('**/*',async(route:any)=>{
      const path=new URL(route.request().url()).pathname;
      if(path==='/api/market-directory')return route.fulfill({json:{schema:'flurbo.market-directory.v1',markets:[{namespace:'practice-2222222222222222222222222222222222222222',label:'Test pool',pool:f.manifest.pool,closesAt:f.manifest.publication.draft.closesAt}]}});
      if(path==='/api/account/access')return route.fulfill({json:{approved:true,testingTools:false}});
      if(path==='/api/auth/session')return route.fulfill({json:{session:{address:owner,method:'passkey',expiresAt:Date.now()+3600_000}}});
      if(path==='/api/practice-2222222222222222222222222222222222222222/status')return route.fulfill({json:{...await f.service.status(),resolved:closed}});
      if(path==='/api/account/wallets')return route.fulfill({json:{account:owner,wallets:[]}});
      if(path==='/api/account/portfolio-sources')return route.fulfill({json:{account:owner,wallets:[],agentWallets:[]}});
      if(path==='/api/practice-2222222222222222222222222222222222222222/markets')return route.fulfill({json:await f.service.markets()});
      if(['/api/network','/api/practice-2222222222222222222222222222222222222222/price-history'].includes(path))return route.fulfill({status:503,json:{error:'Offline fixture'}});
      if(path==='/api/practice-2222222222222222222222222222222222222222/thesis'){
        const input=route.request().postDataJSON();requests.push(input);
        if(delay)await new Promise<void>(r=>{release=r;});
        if(fail)return route.fulfill({status:503,json:{error:'Comparison temporarily unavailable'}});
        return route.fulfill({json:response(input)});
      }
      if(path.startsWith('/api/')){requests.push(path);return route.fulfill({status:503,json:{error:'Unexpected API'}});}
      const relative=path.startsWith('/assets/')?path.slice(1):'index.html';
      return route.fulfill({body:await readFile(new URL('../dist/'+relative,import.meta.url)),contentType:relative.endsWith('.js')?'text/javascript':relative.endsWith('.css')?'text/css':relative.endsWith('.woff2')?'font/woff2':'text/html'});
    });
    await page.clock.install();await page.clock.pauseAt(new Date());
    await page.goto('https://flurbo.singu.online/markets/practice-2222222222222222222222222222222222222222/0/thesis');
    const compare=page.getByRole('button',{name:'Compare with pool',exact:true}),review=page.getByRole('button',{name:'Review this prediction'});
    await compare.waitFor();assert.equal(requests.length,0);

    assert.deepEqual(await page.locator('.thesis-candidate h3').allTextContents(),['Individual','Both answers (AND)','At least one (OR)','Exactly one']);
    for(const [name,explanation] of [['Individual','A does not affect'],['At least one (OR)','including when both match'],['Exactly one','loses if both match'],['Both answers (AND)','does not refund']]){
      await page.locator('.thesis-candidate').filter({has:page.getByRole('heading',{name,exact:true})}).click();
      assert.ok((await page.locator('.thesis-warning').innerText()).includes(explanation));
    }
    assert.equal(requests.length,0);assert.equal(await review.isDisabled(),true);
    assert.equal(await page.locator('.thesis-candidate').getByText('Not loaded',{exact:true}).count(),8);
    await page.clock.runFor(500);
    await page.getByRole('button',{name:'Refresh comparison',exact:true}).waitFor();
    assert.equal(requests.length,1,'one automatic baseline, without submitting personal beliefs');
    assert.equal(await page.getByRole('button',{name:'Start from pool estimates'}).isEnabled(),true);
    if(process.env.FLURBO_TEST_SCREENSHOT)await page.screenshot({path:process.env.FLURBO_TEST_SCREENSHOT.replace('.png','-initial.png'),fullPage:true});
    await page.getByLabel('Chance B is Yes, if A is Yes',{exact:true}).fill('80');
    // A failed price request must not hide the choices or enable a trade.
    fail=true;await page.getByRole('button',{name:'Refresh comparison',exact:true}).click();await page.getByRole('alert').waitFor();
    assert.equal(await page.locator('.thesis-candidate').count(),4);assert.equal(await review.isDisabled(),true);
    await page.locator('.thesis-candidate').filter({has:page.getByRole('heading',{name:'At least one (OR)',exact:true})}).click();
    assert.ok((await page.locator('.thesis-warning').innerText()).includes('including when both match'));
    fail=false;await compare.click();await page.getByRole('button',{name:'Refresh comparison',exact:true}).waitFor();
    await page.locator('.thesis-candidate').filter({has:page.getByRole('heading',{name:'Both answers (AND)',exact:true})}).click();
    assert.equal(await review.isDisabled(),true);assert.equal(await page.locator('.thesis-distribution').count(),0);
    await page.getByLabel('Chance A is Yes',{exact:true}).fill('30');
    await page.getByLabel('Chance B is Yes, if A is No',{exact:true}).fill('20');
    assert.deepEqual(await page.locator('.thesis-distribution strong').allTextContents(),['56.0%','6.0%','14.0%','24.0%']);
    assert.equal(await review.isEnabled(),true);assert.equal(requests.length,3);
    await page.clock.runFor(600);assert.equal(requests.length,3,'personal forecasts do not fetch or leave a delayed duplicate comparison');
    await page.getByText('Add a reasoning note',{exact:true}).click();await page.getByLabel('Why do you expect this connection?').fill('This private forecast must never leave the page.');
    await page.getByText('If an answer becomes VOID',{exact:true}).click();
    assert.ok((await page.locator('.thesis-void').innerText()).includes('0.25'));
    await page.getByText('If an answer becomes VOID',{exact:true}).click();
    if(process.env.FLURBO_TEST_SCREENSHOT)await page.screenshot({path:process.env.FLURBO_TEST_SCREENSHOT,fullPage:true});
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    if(process.env.FLURBO_TEST_SCREENSHOT)await page.screenshot({path:process.env.FLURBO_TEST_SCREENSHOT.replace('.png','-mobile.png'),fullPage:true});
    // Quantity or answers invalidate the comparison immediately, even while another response is pending.
    delay=true;await page.getByRole('button',{name:'Refresh comparison',exact:true}).click();
    await page.getByRole('button',{name:'Checking one snapshot...'}).waitFor();
    assert.equal(await page.locator('.thesis-candidate').count(),4);
    assert.equal(await page.locator('.thesis-candidate').getByText('Loading...',{exact:true}).count(),8);
    assert.equal(await review.isDisabled(),true);
    await page.getByLabel('Shares per option').fill('2');
    assert.equal(await page.locator('.thesis-candidate').count(),4);
    assert.equal(await page.locator('.thesis-candidate').getByText('Not loaded',{exact:true}).count(),8);
    assert.equal(await review.isDisabled(),true);release();delay=false;
    await page.getByRole('radiogroup',{name:"A's selected answer"}).getByRole('radio',{name:'No',exact:true}).click();
    await compare.click();await page.getByRole('button',{name:'Refresh comparison',exact:true}).waitFor();
    await page.locator('.thesis-candidate').filter({has:page.getByRole('heading',{name:'Exactly one',exact:true})}).click();
    await review.click();await page.getByRole('heading',{name:'Your combined prediction'}).waitFor();
    assert.ok(page.url().endsWith('/markets/practice-2222222222222222222222222222222222222222/0?answer=no'));
    const draft=await page.evaluate((key:string)=>JSON.parse(localStorage.getItem(key)!),`flurbo.checkout.v1:practice-2222222222222222222222222222222222222222:${owner}`);
    assert.deepEqual(draft.legs,[0,1]);assert.deepEqual(draft.answers,{'0':false,'1':true});assert.equal(draft.rule,'EXACTLY_ONE');assert.equal(draft.quantity,'2');assert.deepEqual(draft.binding,{pool:f.manifest.pool,rulesHash:f.manifest.rulesHash});
    assert.equal(await page.getByRole('radio',{name:/Exactly one/}).isChecked(),true);
    assert.equal(await page.getByLabel('Shares',{exact:true}).inputValue(),'2');
    assert.ok(requests.every(r=>typeof r==='object'&&Object.keys(r).sort().join(',')==='a,b,quantity,yesA,yesB'));
    // Reload and question changes discard unsaved beliefs; closed comparisons never offer execution.
    await page.goto('https://flurbo.singu.online/markets/practice-2222222222222222222222222222222222222222/0/thesis');await compare.waitFor();
    assert.equal(await page.getByLabel('Chance A is Yes',{exact:true}).inputValue(),'');
    await compare.click();await page.getByRole('button',{name:'Refresh comparison',exact:true}).waitFor();await page.getByRole('button',{name:'Start from pool estimates'}).click();
    assert.equal(await page.getByLabel('Chance A is Yes',{exact:true}).inputValue(),'50.0');
    await page.getByRole('combobox',{name:'Question B',exact:true}).click();await page.getByRole('option').nth(2).click();assert.equal(await page.getByLabel('Chance A is Yes',{exact:true}).inputValue(),'');
    await compare.click();await page.getByRole('button',{name:'Refresh comparison',exact:true}).waitFor();
    await page.getByRole('button',{name:'Start from pool estimates'}).click();
    await page.clock.setSystemTime(new Date(Date.now()+65_000));await page.clock.runFor(1001);await page.getByText(/This comparison has expired/).waitFor();assert.equal(await review.isDisabled(),true);
    await page.clock.setSystemTime(new Date());closed=true;await page.goto('https://flurbo.singu.online/markets/practice-2222222222222222222222222222222222222222/0/thesis');await compare.click();await page.getByRole('button',{name:'Refresh comparison',exact:true}).waitFor();
    await page.getByRole('button',{name:'Start from pool estimates'}).click();assert.equal(await review.isDisabled(),true);
    assert.deepEqual(errors,[]);
  }finally{release();await browser.close();}
});
