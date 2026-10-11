import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {owner,hash} from './pool-fixture.ts';
test('fresh devices see both linked wallets and their market totals',{skip:!process.env.FLURBO_TEST_PLAYWRIGHT},async()=>{
  const {chromium}=await import(pathToFileURL(process.env.FLURBO_TEST_PLAYWRIGHT!).href);
  const browser=await chromium.launch({headless:true,executablePath:process.env.FLURBO_TEST_BROWSER});
  const login='0x'+'99'.repeat(20),second='0x'+'88'.repeat(20),errors:string[]=[];
  const pool='0x'+'22'.repeat(20),now=Math.floor(Date.now()/1000),closesAt=now+86400,questions=[1,2,3,4].map(i=>`Test event ${i}`);
  const hybridMarkets=questions.map((question,eventIndex)=>({id:`${pool}-${eventIndex}`,pool,poolTitle:'October practice',eventIndex,question,route:'mechanical',closesAt,observationEndsAt:closesAt+3600}));
  const snapshot={blockNumber:'200',blockHash:hash,timestamp:now};
  try{
    for(const width of [1280,390]){
      const context=await browser.newContext({viewport:{width,height:1000}}),page=await context.newPage();
      page.on('pageerror',(e:Error)=>errors.push(e.message));
      await page.route('**/*',async(route:any)=>{
        const p=new URL(route.request().url()).pathname;
        if(p==='/api/account/access')return route.fulfill({json:{approved:true,testingTools:false}});
        if(p==='/api/auth/session')return route.fulfill({json:{session:{address:login,method:'passkey',expiresAt:Date.now()+3600000}}});
        if((p==='/api/account/wallets'||p==='/api/account/portfolio-sources'))return route.fulfill({json:{account:login,wallets:[owner,second]}});
        if(p==='/api/market-directory')return route.fulfill({json:{schema:'flurbo.market-directory.v1',markets:[{namespace:'practice-'+pool.slice(2),label:'October practice',pool,closesAt}],oracleMarkets:[],hybridMarkets}});
        if(p===`/api/hybrid/pool/${pool}/account`)return route.fulfill({json:{schema:'flurbo.hybrid-portfolio-account.v1',manifest:{pool,resolver:'0x'+'33'.repeat(20),chainId:10143,
          publication:{draft:{title:'October practice',closesAt,events:questions.map((question,i)=>({id:`event-${i}`,question,route:'mechanical',observationEndsAt:closesAt+3600}))}}},snapshot,claimScopes:[1]}});
        if(p===`/api/hybrid/pool/${pool}/history`)return route.fulfill({json:{complete:true,through:200,target:200,logs:[owner,second].map((trader,i)=>({hash,index:i,block:150+i,name:'Traded',args:{trader,scope:1,mask:'2',quantity:i?'3000000':'10000000',isBuy:true,collateralAmount:'1000000'}}))}});
        if(p===`/api/hybrid/pool/${pool}/collected-payouts`)return route.fulfill({json:{complete:true,through:200,target:200,logs:[]}});
        if(p===`/api/hybrid/pool/${pool}/positions`){
          const input=route.request().postDataJSON();return route.fulfill({json:{schema:'flurbo.hybrid-portfolio-positions.v1',owner:input.owner,snapshot,resolved:false,
            rows:input.claims.map((c:any)=>({scope:c.scope,mask:c.mask,quantity:c.scope===1&&c.mask==='2'?(input.owner===owner?'10000000':input.owner===second?'3000000':'0'):'0',payoutAtoms:null}))}});
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
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      if(process.env.FLURBO_TEST_SCREENSHOT)await page.screenshot({path:process.env.FLURBO_TEST_SCREENSHOT.replace('.png',`-${width}.png`),fullPage:true});
      await context.close();
    }
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
