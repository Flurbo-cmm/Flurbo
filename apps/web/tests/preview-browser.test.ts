import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {pilotFixture,owner} from './pilot-fixture.ts';

test('invite flow denies pending accounts, approved directory filters real schedules and survives a pool outage',{skip:!process.env.FLURBO_TEST_PLAYWRIGHT},async()=>{
  const {chromium}=await import(pathToFileURL(process.env.FLURBO_TEST_PLAYWRIGHT!).href);
  const browser=await chromium.launch({headless:true,executablePath:process.env.FLURBO_TEST_BROWSER});
  const now=Math.floor(Date.now()/1000),f=pilotFixture(now,4),other=structuredClone(f.manifest);
  // Practice collections are addressed by pool; this mode keeps the real-event wording.
  f.manifest.publication.mode='deterministic-source-v1';
  other.publication.mode='rehearsal';other.pool='0x'+'bc'.repeat(20);other.publication.draft.closesAt=now-3600;
  other.publication.draft.events.forEach((e:any,i:number)=>e.question='Earlier question '+(i+1));
  const ns='practice-'+other.pool.slice(2);
  let signedIn=false,approved=false,applicationUrl:string|null=null,outage=false,reads=0;
  const errors:string[]=[];
  try{
    const page=await browser.newPage();page.on('pageerror',(e:Error)=>errors.push(e.message));
    await page.route('**/*',async(route:any)=>{
      const path=new URL(route.request().url()).pathname;
      if(path==='/api/preview')return route.fulfill({json:{inviteOnly:true,applicationUrl}});
      if(path==='/api/auth/session')return route.fulfill({json:{session:signedIn?{address:owner,method:'passkey',expiresAt:Date.now()+3600000}:null}});
      if(path==='/api/account/access')return route.fulfill({json:{approved,testingTools:false,applicationUrl}});
      if(path==='/api/market-directory'){reads++;return route.fulfill({json:{schema:'flurbo.market-directory.v1',markets:[{namespace:'practice-2222222222222222222222222222222222222222',label:'Open questions',pool:f.manifest.pool,closesAt:f.manifest.publication.draft.closesAt},{namespace:ns,label:'Earlier questions',pool:other.pool,closesAt:other.publication.draft.closesAt}]}});}
      if(path==='/api/practice-2222222222222222222222222222222222222222/markets')return route.fulfill({json:await f.service.markets()});
      if(path===`/api/${ns}/markets`)return route.fulfill(outage?{status:503,json:{error:'Unavailable'}}:{json:{...await f.service.markets(),manifest:other,open:false,resolved:true}});
      if(path.startsWith('/api/'))return route.fulfill({status:503,json:{error:'Unused fixture endpoint'}});
      const file=path.startsWith('/assets/')?path.slice(1):'index.html';
      return route.fulfill({body:await readFile(new URL('../dist/'+file,import.meta.url)),contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.woff2')?'font/woff2':'text/html'});
    });
    await mkdir(new URL('../../../target/preview-ui/',import.meta.url),{recursive:true});
    for(const width of [1440,390]){
      await page.setViewportSize({width,height:900});await page.goto('https://flurbo.singu.online/');
      await page.getByText('Invite-based testnet preview',{exact:true}).waitFor();
      assert.match(await page.locator('.home-visitor-status').innerText(),/Applications are not open/);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      await page.screenshot({path:fileURLToPath(new URL(`../../../target/preview-ui/home-${width}.png`,import.meta.url)),fullPage:true});
      await page.goto('https://flurbo.singu.online/docs');await page.getByRole('heading',{name:'Getting started',exact:true}).waitFor();
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    }
    await page.goto('https://flurbo.singu.online/markets');await page.waitForURL('**/login');assert.equal(reads,0);
    signedIn=true;
    for(const path of ['/markets','/portfolio','/fund','/markets/practice-2222222222222222222222222222222222222222/0']){
      await page.goto('https://flurbo.singu.online'+path);await page.getByRole('heading',{name:'Your account is ready',exact:true}).waitFor();assert.equal(reads,0);
    }
    assert.equal(await page.getByRole('link',{name:'Request access',exact:true}).count(),0);
    applicationUrl='https://docs.google.com/forms/d/e/example/viewform';await page.getByRole('button',{name:'Check access',exact:true}).click();
    await page.getByRole('link',{name:'Request access',exact:true}).waitFor();
    assert.equal(await page.getByRole('link',{name:'Request access',exact:true}).getAttribute('href'),applicationUrl);
    assert.equal(await page.locator('.access-identity code').innerText(),owner);
    await page.screenshot({path:fileURLToPath(new URL('../../../target/preview-ui/access-mobile.png',import.meta.url)),fullPage:true});
    approved=true;await page.goto('https://flurbo.singu.online/markets');
    await page.locator('.market-card').nth(3).waitFor();
    assert.equal(await page.getByRole('button',{name:'Open',exact:true}).getAttribute('aria-pressed'),'true');
    await page.getByRole('button',{name:'All',exact:true}).click();
    for(const width of [1440,390]){
      await page.setViewportSize({width,height:900});await page.locator('.market-card').nth(7).waitFor({timeout:10000}).catch(async(e:Error)=>{throw Error(e.message+'\n'+await page.locator('body').innerText());});
      assert.equal(await page.getByLabel('Collection',{exact:true}).count(),0);
      await page.getByRole('button',{name:'Open',exact:true}).click();assert.equal(await page.locator('.market-card').count(),4);
      await page.getByRole('button',{name:'Settled',exact:true}).click();assert.equal(await page.locator('.market-card').count(),4);
      await page.getByRole('button',{name:'All',exact:true}).click();
      await page.getByRole('textbox',{name:'Search markets'}).fill('Earlier question 1');assert.equal(await page.locator('.market-card').count(),1);
      await page.getByRole('textbox',{name:'Search markets'}).fill('');
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      await page.screenshot({path:fileURLToPath(new URL(`../../../target/preview-ui/markets-${width}.png`,import.meta.url)),fullPage:true});
    }
    outage=true;await page.getByRole('button',{name:'Refresh prices',exact:true}).click();
    await page.getByText('Some markets could not be refreshed.',{exact:false}).waitFor();assert.equal(await page.locator('.market-card').count(),4);
    approved=false;await page.reload();await page.getByRole('heading',{name:'Your account is ready',exact:true}).waitFor();
    assert.equal(await page.locator('.market-card').count(),0);assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
