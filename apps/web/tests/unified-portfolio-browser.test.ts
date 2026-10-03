import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile,mkdir} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {pilotFixture,owner,hash} from './pilot-fixture.ts';
test('one portfolio combines pools, shows account-only trades and reveals real PnL only after full history',{skip:!process.env.FLURBO_TEST_PLAYWRIGHT},async()=>{
 const {chromium}=await import(pathToFileURL(process.env.FLURBO_TEST_PLAYWRIGHT!).href),browser=await chromium.launch({headless:true,executablePath:process.env.FLURBO_TEST_BROWSER});
 const login='0x'+'99'.repeat(20),second='0x'+'88'.repeat(20),poolB='0x'+'aa'.repeat(20),f=pilotFixture(Math.floor(Date.now()/1000)),nsB='practice-'+poolB.slice(2);
 f.manifest.publication.draft.events[0].question='Will the selected Ethereum block contain at least 150 transactions and have a higher base fee than the previous block, according to the published observation rules?';
 let complete=false,fail=false,active=0,max=0,accounts=0;const errors:string[]=[];
 const log=(index:number,trader:string,isBuy:boolean,quantity:string,collateralAmount:string,name='Traded')=>({name,hash,index,block:100+index,args:{trader,owner:trader,scope:1,mask:'2',isBuy,quantity,collateralAmount}});
 const logsA=[log(0,owner,true,'10000000','5000000'),log(1,second,true,'2000000','1000000'),log(2,owner,false,'4000000','3000000'),log(9,'0x'+'77'.repeat(20),true,'9000000','4000000')];
 const logsB=[log(3,owner,true,'5000000','2000000'),log(4,owner,false,'5000000','5000000','Redeemed'),log(5,second,true,'3000000','1000000')];
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',(e:Error)=>errors.push(e.message));
  await page.clock.install();await page.clock.pauseAt(new Date());
  await page.route('**/*',async(route:any)=>{
   const u=new URL(route.request().url()),p=u.pathname,b=p.startsWith('/api/'+nsB+'/'),manifest={...f.manifest,pool:b?poolB:f.manifest.pool,publication:{...f.manifest.publication,mode:'rehearsal'}};
   if(p==='/api/auth/session')return route.fulfill({json:{session:{address:login,method:'passkey',expiresAt:Date.now()+3600000}}});
   if(p==='/api/account/access')return route.fulfill({json:{approved:true}});
   if((p==='/api/account/wallets'||p==='/api/account/portfolio-sources'))return route.fulfill({json:{account:login,wallets:[owner,second]}});
   if(p==='/api/market-directory')return route.fulfill({json:{schema:'flurbo.market-directory.v1',markets:[{namespace:'practice-2222222222222222222222222222222222222222',label:'Hidden group A',pool:f.manifest.pool,closesAt:f.manifest.publication.draft.closesAt},{namespace:nsB,label:'Hidden group B',pool:poolB,closesAt:f.manifest.publication.draft.closesAt}]}});
   if(p.endsWith('/account')){accounts++;return route.fulfill({json:{...await f.service.account(u.searchParams.get('wallet')),manifest}});}
   if(p.endsWith('/status'))return route.fulfill({json:{...await f.service.status(),manifest}});
   if(p.endsWith('/positions')){
    const q=route.request().postDataJSON();assert.ok(q.claims.length<=30);active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,15));active--;
    if(fail&&b)return route.fulfill({status:503,json:{error:'Unavailable'}});
    return route.fulfill({json:{owner:q.owner,snapshot:{blockNumber:'200'},rows:q.claims.map((c:any)=>{const quantity=c.scope===1&&c.mask==='2'?(b?(q.owner===second?'3000000':'0'):(q.owner===owner?'6000000':q.owner===second?'2000000':'0')):'0';return {...c,quantity,payoutAtoms:b?quantity:null};})}});
   }
   if(p.endsWith('/collected-payouts'))return route.fulfill({json:{complete:true,through:200,target:200,logs:b?[logsB[1],log(10,'0x'+'77'.repeat(20),false,'50000000','50000000','Redeemed')]:[]}});
   if(p.endsWith('/history'))return route.fulfill({json:{complete,through:150,target:200,logs:b?logsB:logsA}});
   if(p.startsWith('/api/'))return route.fulfill({status:503,json:{error:'Unused'}});
   const relative=p.startsWith('/assets/')?p.slice(1):'index.html';return route.fulfill({body:await readFile(new URL('../dist/'+relative,import.meta.url)),contentType:relative.endsWith('.js')?'text/javascript':relative.endsWith('.css')?'text/css':'text/html'});
  });
  await page.goto('https://flurbo.singu.online/portfolio');await page.getByRole('cell',{name:'8',exact:true}).waitFor();await page.getByRole('cell',{name:'3',exact:true}).waitFor();await page.getByRole('button',{name:'Refresh',exact:true}).waitFor();
  assert.equal(accounts,2);assert.ok(max<=4,`at most four concurrent holdings reads (two pools, two wallets each), saw ${max}`);assert.equal(await page.getByRole('heading',{name:'Your shares',exact:true}).count(),1);assert.equal(await page.getByRole('table').count(),1);assert.doesNotMatch(await page.locator('body').innerText(),/Hidden group|SEPTEMBER|Results\n/);
  assert.equal(await page.getByRole('img',{name:/Realized PnL/}).count(),0);
  await page.getByRole('button',{name:'Activity',exact:true}).click();await page.getByRole('heading',{name:'Your trades'}).waitFor();assert.equal(await page.locator('.portfolio-activity tbody tr').count(),6);
  await page.getByRole('button',{name:'Collected',exact:true}).click();await page.getByRole('heading',{name:'Collected payouts'}).waitFor();assert.equal(await page.locator('.portfolio-activity tbody tr').count(),1);assert.match(await page.locator('.portfolio-summary-grid').innerText(),/Payouts collected\n5/);
  complete=true;await page.clock.runFor(3100);await page.getByRole('button',{name:'Performance',exact:true}).click();await page.getByRole('img',{name:/Realized PnL after 2.*\+4 test AUSD/}).waitFor();assert.equal(accounts,2,'background history catches up without rereading accounts');
  await page.getByRole('button',{name:/Holdings ·/}).click();
  await mkdir(new URL('../../../target/unified-portfolio/',import.meta.url),{recursive:true});
  for(const width of [1440,390]){await page.setViewportSize({width,height:1000});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);if(width===1440)assert.equal(await page.locator('.unified-holdings tbody tr').first().evaluate((row:any)=>row.querySelector('strong').getBoundingClientRect().right<=row.children[1].getBoundingClientRect().left),true);await page.screenshot({path:new URL(`../../../target/unified-portfolio/portfolio-${width}.png`,import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1'),fullPage:true});}
  fail=true;await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.getByRole('alert').waitFor();await page.getByRole('button',{name:'Refresh',exact:true}).waitFor();assert.equal(await page.getByRole('img',{name:/Realized PnL/}).count(),0);await page.getByRole('cell',{name:'8',exact:true}).waitFor();
  fail=false;await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.getByRole('button',{name:'Performance',exact:true}).click();await page.getByRole('img',{name:/Realized PnL after 2/}).waitFor();assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
