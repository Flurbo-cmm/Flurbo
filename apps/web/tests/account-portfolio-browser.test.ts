import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {pilotFixture,owner,hash} from './pilot-fixture.ts';
test('fresh devices see both linked wallets; market totals and sparse chart remain clear',{skip:!process.env.FLURBO_TEST_PLAYWRIGHT},async()=>{
  const {chromium}=await import(pathToFileURL(process.env.FLURBO_TEST_PLAYWRIGHT!).href);
  const browser=await chromium.launch({headless:true,executablePath:process.env.FLURBO_TEST_BROWSER});
  const f=pilotFixture(Math.floor(Date.now()/1000),4),login='0x'+'99'.repeat(20),second='0x'+'88'.repeat(20),errors:string[]=[];
  // Practice collections are addressed by pool; this mode keeps the real-event wording.
  f.manifest.publication.mode='deterministic-source-v1';
  try{
    for(const width of [1280,390]){
      const context=await browser.newContext({viewport:{width,height:1000}}),page=await context.newPage();
      page.on('pageerror',(e:Error)=>errors.push(e.message));
      await page.route('**/*',async(route:any)=>{
        const u=new URL(route.request().url()),p=u.pathname;
        if(p==='/api/account/access')return route.fulfill({json:{approved:true,testingTools:false}});
        if(p==='/api/auth/session')return route.fulfill({json:{session:{address:login,method:'passkey',expiresAt:Date.now()+3600000}}});
        if((p==='/api/account/wallets'||p==='/api/account/portfolio-sources'))return route.fulfill({json:{account:login,wallets:[owner,second]}});
        if(p==='/api/market-directory')return route.fulfill({json:{schema:'flurbo.market-directory.v1',active:'practice-2222222222222222222222222222222222222222',markets:[{namespace:'practice-2222222222222222222222222222222222222222',label:'October practice',pool:f.manifest.pool,closesAt:f.manifest.publication.draft.closesAt}]}});
        if(p==='/api/practice-2222222222222222222222222222222222222222/account')return route.fulfill({json:await f.service.account(u.searchParams.get('wallet'))});
        if(p==='/api/practice-2222222222222222222222222222222222222222/status')return route.fulfill({json:await f.service.status()});
        if(p==='/api/practice-2222222222222222222222222222222222222222/markets')return route.fulfill({json:await f.service.markets()});
        if(p==='/api/practice-2222222222222222222222222222222222222222/history')return route.fulfill({json:{complete:true,through:200,target:200,logs:[owner,second].map((trader,i)=>({hash,index:i,block:150+i,name:'Traded',args:{trader,scope:1,mask:'2',quantity:i?'3000000':'10000000',isBuy:true,collateralAmount:'1000000'}}))}});
        if(p==='/api/practice-2222222222222222222222222222222222222222/positions'){
          const input=route.request().postDataJSON();return route.fulfill({json:{snapshot:{blockNumber:'200'},rows:input.claims.map((c:any)=>({...c,quantity:c.scope===1&&c.mask==='2'?(input.owner===owner?'10000000':input.owner===second?'3000000':'0'):'0',payoutAtoms:null}))}});
        }
        if(p==='/api/practice-2222222222222222222222222222222222222222/price-history'){
          const end=Math.floor(Date.now()/1000);return route.fulfill({json:{pool:f.manifest.pool,sampling:'current',points:[end-3600,end-3300,end].map((timestamp,i)=>({timestamp,blockNumber:String(100+i),prices:[{event:0,yes:i===2?'740737':'512495',no:i===2?'278922':'512495'}]}))}});
        }
        if(p.startsWith('/api/'))return route.fulfill({status:503,json:{error:'Unexpected API'}});
        const relative=p.startsWith('/assets/')?p.slice(1):'index.html';return route.fulfill({body:await readFile(new URL('../dist/'+relative,import.meta.url)),contentType:relative.endsWith('.js')?'text/javascript':relative.endsWith('.css')?'text/css':'text/html'});
      });
      await page.goto('https://flurbo.singu.online/portfolio');
      await page.getByRole('cell',{name:'13',exact:true}).waitFor();
      assert.equal(await page.getByRole('textbox',{name:'Wallet to view'}).isVisible(),false);
      assert.equal(await page.evaluate((a:string)=>sessionStorage.getItem('flurbo.metamask-wallet:'+a),login),null); // No local wallet preference is required.
      await page.reload();await page.getByRole('cell',{name:'13',exact:true}).waitFor();
      await page.goto('https://flurbo.singu.online/history');await page.waitForURL('**/portfolio');await page.getByRole('cell',{name:'13',exact:true}).waitFor();
      assert.equal(await page.locator('a[href="/history"]').count(),0);
      await page.goto('https://flurbo.singu.online/markets/practice-2222222222222222222222222222222222222222/0');await page.getByText('13 shares',{exact:true}).waitFor();
      assert.equal(await page.getByRole('option',{name:'Collect payout',exact:true}).count(),0);
      const chart=page.getByRole('region',{name:'Price history',exact:true});await chart.getByRole('img').waitFor();
      assert.equal(await chart.locator('rect').count(),1);assert.equal(await chart.locator('line[stroke-dasharray="2 6"]').count(),2);
      assert.equal(await page.getByText('MetaMask connection',{exact:true}).count(),0);
      const geometry=await page.locator('.ticket-wallet').evaluate((el:any)=>{const a=el.querySelector('strong').getBoundingClientRect(),b=el.querySelector('button').getBoundingClientRect();return a.right<=b.left||a.bottom<=b.top;});assert.equal(geometry,true);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      if(process.env.FLURBO_TEST_SCREENSHOT)await page.screenshot({path:process.env.FLURBO_TEST_SCREENSHOT.replace('.png',`-${width}.png`),fullPage:true});
      await context.close();
    }
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
