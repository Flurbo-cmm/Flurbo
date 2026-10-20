import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {owner} from './pool-fixture.ts';

test('invite flow denies pending accounts, approved directory filters real schedules and survives a pool outage',{skip:!process.env.FLURBO_TEST_PLAYWRIGHT},async()=>{
  const {chromium}=await import(pathToFileURL(process.env.FLURBO_TEST_PLAYWRIGHT!).href);
  const browser=await chromium.launch({headless:true,executablePath:process.env.FLURBO_TEST_BROWSER});
  const now=Math.floor(Date.now()/1000),open='0x'+'22'.repeat(20),earlier='0x'+'bc'.repeat(20);
  // Two hybrid pools of four questions: one open, one settled.
  const pool=(address:string,title:string,closesAt:number,question:(i:number)=>string)=>[0,1,2,3].map(eventIndex=>({id:`${address}-${eventIndex}`,pool:address,poolTitle:title,eventIndex,
    question:question(eventIndex),route:'mechanical',closesAt,observationEndsAt:closesAt+3600}));
  const hybridMarkets=[...pool(open,'Open questions',now+86400,i=>`Test event ${i+1}`),...pool(earlier,'Earlier questions',now-3600,i=>'Earlier question '+(i+1))];
  let signedIn=false,approved=false,applicationUrl:string|null=null,outage=false,reads=0;
  const errors:string[]=[];
  try{
    const page=await browser.newPage();page.on('pageerror',(e:Error)=>errors.push(e.message));
    await page.route('**/*',async(route:any)=>{
      const path=new URL(route.request().url()).pathname;
      if(path==='/api/preview')return route.fulfill({json:{inviteOnly:true,applicationUrl}});
      if(path==='/api/auth/session')return route.fulfill({json:{session:signedIn?{address:owner,method:'passkey',expiresAt:Date.now()+3600000}:null}});
      if(path==='/api/account/access')return route.fulfill({json:{approved,testingTools:false,applicationUrl}});
      if(path==='/api/market-directory'){reads++;return route.fulfill({json:{schema:'flurbo.market-directory.v1',markets:[],oracleMarkets:[],hybridMarkets}});}
      const market=hybridMarkets.find(m=>path===`/api/hybrid/${m.id}/market`);
      if(market&&market.pool===earlier&&outage)return route.fulfill({status:503,json:{error:'Unavailable'}});
      if(market)return route.fulfill({json:{schema:'flurbo.hybrid-market.v1',id:market.id,pool:market.pool,marketNow:Math.floor(Date.now()/1000),funded:true,resolved:market.pool===earlier,prices:{yes:'450000',no:'550000'}}});
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
    // The board fits as many cards as the window holds and pages the rest, so every question is read across pages.
    // The board re-measures after a resize and animates between pages; read only once its count and pager stop changing.
    const settle=async()=>{
      let last='',same=0;
      for(let i=0;i<80&&same<3;i++){
        const now=JSON.stringify([await page.locator('.board-count').innerText().catch(()=>''),await page.locator('.pager-number').count()]);
        same=now===last?same+1:0;last=now;await page.waitForTimeout(150);
      }
    };
    const everyQuestion=async()=>{
      await settle();
      const seen=new Set<string>(),pages=await page.locator('.pager-number').count()||1;
      for(let n=1;n<=pages;n++){
        if(pages>1){await page.getByRole('button',{name:`Page ${n}`,exact:true}).click();await page.locator('.pager [aria-current="page"]').filter({hasText:String(n)}).waitFor();await settle();}
        for(const question of await page.locator('.market-card .tile-q').allInnerTexts())seen.add(question);
      }
      if(pages>1){await settle();await page.getByRole('button',{name:'Page 1',exact:true}).click();await settle();}
      return [...seen].sort();
    };
    const questions=hybridMarkets.map(m=>m.question).sort();
    for(const width of [1440,390]){
      await page.setViewportSize({width,height:900});await page.locator('.board-count').filter({hasText:'of 8 markets'}).waitFor({state:'attached',timeout:10000});
      assert.deepEqual(await everyQuestion(),questions);
      assert.equal(await page.getByLabel('Collection',{exact:true}).count(),0);
      await page.getByRole('button',{name:'Open',exact:true}).click();assert.equal(await page.locator('.market-card').count(),4);
      await page.getByRole('button',{name:'Settled',exact:true}).click();assert.equal(await page.locator('.market-card').count(),4);
      await page.getByRole('button',{name:'All',exact:true}).click();
      await page.getByRole('textbox',{name:'Search markets'}).fill('Earlier question 1');assert.equal(await page.locator('.market-card').count(),1);
      await page.getByRole('textbox',{name:'Search markets'}).fill('');
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      await page.screenshot({path:fileURLToPath(new URL(`../../../target/preview-ui/markets-${width}.png`,import.meta.url)),fullPage:true});
    }
    // A market whose price read fails keeps its card; only the notice says it could not be refreshed.
    outage=true;await page.getByRole('button',{name:'Refresh prices',exact:true}).click();
    await page.getByText('Some markets could not be refreshed.',{exact:false}).waitFor();assert.equal(await page.locator('[data-market-count="8"]').count(),1);
    approved=false;await page.reload();await page.getByRole('heading',{name:'Your account is ready',exact:true}).waitFor();
    assert.equal(await page.locator('.market-card').count(),0);assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
