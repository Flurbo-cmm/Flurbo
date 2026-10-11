import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {owner} from './pool-fixture.ts';

// One hybrid pool with four questions, as the hybrid portfolio API serves it.
const pool='0x'+'22'.repeat(20),now=Math.floor(Date.now()/1000),closesAt=now+86400,questions=[1,2,3,4].map(i=>`Test event ${i}`);
const hybridMarkets=questions.map((question,eventIndex)=>({id:`${pool}-${eventIndex}`,pool,poolTitle:'Practice markets',eventIndex,question,route:'mechanical',closesAt,observationEndsAt:closesAt+3600}));
const snapshot={blockNumber:'100',blockHash:'0x'+'44'.repeat(32),timestamp:now};
const account={schema:'flurbo.hybrid-portfolio-account.v1',manifest:{pool,resolver:'0x'+'33'.repeat(20),chainId:10143,publication:{draft:{title:'Practice markets',closesAt,
  events:questions.map((question,i)=>({id:`event-${i}`,question,route:'mechanical',observationEndsAt:closesAt+3600}))}}},snapshot,claimScopes:[3,5,6,7,9,10,11,12,13,14]};
const quantity=(c:any,wallet:string,second:string)=>c.scope===1&&c.mask==='2'?(wallet===owner?'10000000':wallet===second?'7000000':'2000000'):
  c.scope===1&&c.mask==='1'&&wallet===second?'4000000':c.scope===14&&c.mask==='128'&&wallet===owner?'3000000':'0';

async function serve(page:any,{login,second,state}:{login:string;second:string;state:{fail:boolean;scans:number;batches:any[];gate:Promise<void>}}){
  await page.route('**/*',async(route:any)=>{
    const path=new URL(route.request().url()).pathname;
    if(path==='/api/account/access')return route.fulfill({json:{approved:true,testingTools:false}});
    if(path==='/api/auth/session')return route.fulfill({json:{session:{address:login,method:'passkey',expiresAt:Date.now()+3600000}}});
    if((path==='/api/account/wallets'||path==='/api/account/portfolio-sources'))return route.fulfill({json:{account:login,wallets:[owner,second]}});
    if(path==='/api/market-directory')return route.fulfill({json:{schema:'flurbo.market-directory.v1',markets:[{namespace:'practice-'+pool.slice(2),label:'Practice markets',pool,closesAt}],oracleMarkets:[],hybridMarkets}});
    if(path===`/api/hybrid/pool/${pool}/account`)return route.fulfill({json:account});
    if(path===`/api/hybrid/pool/${pool}/history`){state.scans++;return route.fulfill({json:{complete:true,through:100,target:100,logs:[]}});}
    if(path===`/api/hybrid/pool/${pool}/collected-payouts`)return route.fulfill({json:{complete:true,through:100,target:100,logs:[]}});
    if(path===`/api/hybrid/pool/${pool}/positions`){
      const input=route.request().postDataJSON();state.batches.push(input);await state.gate;
      if(state.fail&&input.owner===second)return route.fulfill({status:503,json:{error:'Read failed'}});
      return route.fulfill({json:{schema:'flurbo.hybrid-portfolio-positions.v1',owner:input.owner,snapshot,resolved:false,
        rows:input.claims.map((c:any)=>({scope:c.scope,mask:c.mask,quantity:quantity(c,input.owner,second),payoutAtoms:null}))}});
    }
    if(path.startsWith('/api/'))return route.fulfill({status:503,json:{error:'Unexpected API'}});
    const relative=path.startsWith('/assets/')?path.slice(1):'index.html';
    return route.fulfill({body:await readFile(new URL('../dist/'+relative,import.meta.url)),contentType:relative.endsWith('.js')?'text/javascript':relative.endsWith('.css')?'text/css':relative.endsWith('.woff2')?'font/woff2':'text/html'});
  });
}

test('one Mera portfolio sums wallets, loads beyond one page of claims, and recovers a partial read',{skip:!process.env.FLURBO_TEST_PLAYWRIGHT},async()=>{
  const {chromium}=await import(pathToFileURL(process.env.FLURBO_TEST_PLAYWRIGHT!).href);
  const browser=await chromium.launch({headless:true,executablePath:process.env.FLURBO_TEST_BROWSER});
  const login='0x'+'99'.repeat(20),second='0x'+'ab'.repeat(20),errors:string[]=[];
  const state={fail:false,scans:0,batches:[] as any[],gate:Promise.resolve()};
  try{
    const page=await browser.newPage({viewport:{width:390,height:844}});
    page.on('pageerror',(e:Error)=>errors.push(e.message));
    await serve(page,{login,second,state});
    await page.goto('https://flurbo.singu.online/portfolio');
    await page.getByRole('cell',{name:'19',exact:true}).waitFor();
    await page.getByRole('cell',{name:'4',exact:true}).waitFor();
    await page.getByText('Test event 2 + Test event 3 + Test event 4',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Refresh',exact:true}).waitFor();
    assert.equal(state.scans,1);assert.ok(state.batches.length>3);assert.ok(state.batches.every(b=>b.claims.length<=60));
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
    state.fail=true;await page.getByRole('button',{name:'Refresh',exact:true}).click();
    await page.getByRole('alert').filter({hasText:'Some shares'}).waitFor();
    await page.getByRole('button',{name:'Refresh',exact:true}).waitFor();
    await page.getByRole('cell',{name:'12',exact:true}).waitFor();
    assert.equal(await page.getByRole('cell',{name:'19',exact:true}).count(),0);
    state.fail=false;await page.getByRole('button',{name:'Refresh',exact:true}).click();
    await page.getByRole('cell',{name:'19',exact:true}).waitFor();
    assert.equal(await page.getByRole('alert').count(),0);assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

test('a returning member sees their last holdings at once, labelled, while fresh balances load',{skip:!process.env.FLURBO_TEST_PLAYWRIGHT},async()=>{
  const {chromium}=await import(pathToFileURL(process.env.FLURBO_TEST_PLAYWRIGHT!).href);
  const browser=await chromium.launch({headless:true,executablePath:process.env.FLURBO_TEST_BROWSER});
  const login='0x'+'99'.repeat(20),second='0x'+'ab'.repeat(20),errors:string[]=[];
  const state={fail:false,scans:0,batches:[] as any[],gate:Promise.resolve()};
  let release=()=>{};
  try{
    const page=await browser.newPage({viewport:{width:390,height:844}});
    page.on('pageerror',(e:Error)=>errors.push(e.message));
    await serve(page,{login,second,state});
    await page.goto('https://flurbo.singu.online/portfolio');
    await page.getByRole('cell',{name:'19',exact:true}).waitFor();
    await page.getByRole('button',{name:'Refresh',exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>Object.keys(localStorage).some(k=>k.startsWith('flurbo.portfolio-cache.v1:'))),true);
    // Second visit: holdings reads are held back, yet the last holdings show immediately and are labelled.
    state.gate=new Promise<void>(r=>{release=r;});
    await page.reload();
    await page.getByRole('cell',{name:'19',exact:true}).waitFor({timeout:5000});
    await page.getByText(/Showing your holdings from/).waitFor();
    assert.equal(await page.getByRole('button',{name:'Collect payout'}).count(),0);
    release();
    await page.getByRole('button',{name:'Refresh',exact:true}).waitFor();
    assert.equal(await page.getByText(/Showing your holdings from/).count(),0);
    await page.getByRole('cell',{name:'19',exact:true}).waitFor();
    assert.deepEqual(errors,[]);
  }finally{release();await browser.close();}
});
