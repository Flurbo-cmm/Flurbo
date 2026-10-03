import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {pilotFixture,owner} from './pilot-fixture.ts';
import {TESTNET} from '../server/network.mjs';

test('Mera keeps linked wallets across pages and reload, while MetaMask restores silently and can switch',{skip:!process.env.FLURBO_TEST_PLAYWRIGHT},async()=>{
 const {chromium}=await import(pathToFileURL(process.env.FLURBO_TEST_PLAYWRIGHT!).href);
 const browser=await chromium.launch({headless:true,executablePath:process.env.FLURBO_TEST_BROWSER});
 const login='0x'+'99'.repeat(20),second='0x'+'ab'.repeat(20),f=pilotFixture(Math.floor(Date.now()/1000),4),requests:any[]=[],errors:string[]=[];
 f.manifest.publication.mode='rehearsal';
 try{
  const page=await browser.newPage();page.on('pageerror',(e:Error)=>errors.push(e.message));
  await page.addInitScript(({owner,second}:any)=>{
   const listeners=new Map<string,Set<()=>void>>();
   (window as any).ethereum={isMetaMask:true,on:(name:string,fn:()=>void)=>{if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name)!.add(fn);},removeListener:(name:string,fn:()=>void)=>listeners.get(name)?.delete(fn),request:async({method}:any)=>{
    if(method==='eth_accounts')return sessionStorage.getItem('locked')?[]:[sessionStorage.getItem('selected')||owner];
    if(method==='eth_chainId')return '0x279f';
    if(method==='wallet_requestPermissions'){sessionStorage.setItem('selected',second);listeners.get('accountsChanged')?.forEach(fn=>fn());return [];}
    if(method==='eth_requestAccounts'){sessionStorage.setItem('connects',String(Number(sessionStorage.getItem('connects')||0)+1));return [sessionStorage.getItem('selected')||owner];}
    throw Error('Unexpected interactive wallet request: '+method);
   }};
  },{owner,second});
  await page.route('**/*',async(route:any)=>{
   const url=new URL(route.request().url()),p=url.pathname;
   if(p==='/api/auth/session')return route.fulfill({json:{session:{address:login,method:'passkey',expiresAt:Date.now()+3600000}}});
   if(p==='/api/account/access')return route.fulfill({json:{approved:true,testingTools:false}});
   if(p==='/api/account/wallets'||p==='/api/account/portfolio-sources')return route.fulfill({json:{account:login,wallets:[owner,second]}});
   if(p==='/api/market-directory')return route.fulfill({json:{schema:'flurbo.market-directory.v1',markets:[{namespace:'practice-2222222222222222222222222222222222222222',label:'Practice',pool:f.manifest.pool,closesAt:f.manifest.publication.draft.closesAt}]}});
   if(p==='/api/network')return route.fulfill({json:{...TESTNET,flurboFaucet:true}});
   if(p==='/api/rpc')return route.fulfill({json:{result:'0x0'}});
   if(p==='/api/practice-2222222222222222222222222222222222222222/status')return route.fulfill({json:await f.service.status(url.searchParams.get('wallet')||undefined)});
   if(p==='/api/practice-2222222222222222222222222222222222222222/markets')return route.fulfill({json:await f.service.markets()});
   if(p==='/api/practice-2222222222222222222222222222222222222222/account')return route.fulfill({json:await f.service.account(url.searchParams.get('wallet'))});
   if(p==='/api/practice-2222222222222222222222222222222222222222/positions'){const input=route.request().postDataJSON();return route.fulfill({json:{owner:input.owner,rows:input.claims.map((c:any)=>({...c,quantity:'0',payoutAtoms:null}))}});}
   if(p==='/api/practice-2222222222222222222222222222222222222222/prepare'){const input=route.request().postDataJSON();requests.push(input);return route.fulfill({json:await f.service.prepare(input)});}
   if(p.endsWith('/collected-payouts')||p.endsWith('/history'))return route.fulfill({json:{complete:true,logs:[]}});
   if(p.startsWith('/api/'))return route.fulfill({status:503,json:{error:'Fixture unavailable'}});
   const file=p.startsWith('/assets/')?p.slice(1):'index.html';return route.fulfill({body:await readFile(new URL('../dist/'+file,import.meta.url)),contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});
  });
  for(const url of ['/markets/practice-2222222222222222222222222222222222222222/0','/markets/practice-2222222222222222222222222222222222222222/1','/fund','/access']){
   await page.goto('https://flurbo.singu.online'+url);await page.getByRole('button',{name:'Switch wallet',exact:true}).waitFor();
   assert.equal(await page.evaluate(()=>sessionStorage.getItem('connects')),null);
  }
  await page.getByText('2 linked wallets',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Switch wallet',exact:true}).click();
  await page.getByText(`Active for trading: ${second.slice(0,8)}...${second.slice(-6)}`,{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>sessionStorage.getItem('connects')),'1');
  await page.goto('https://flurbo.singu.online/markets/practice-2222222222222222222222222222222222222222/0');await page.getByRole('button',{name:'Allow payment',exact:true}).waitFor();assert.equal(requests.at(-1).owner,second);
  await page.reload();await page.getByRole('button',{name:'Allow payment',exact:true}).waitFor();assert.equal(await page.evaluate(()=>sessionStorage.getItem('connects')),'1');
  await page.evaluate(()=>sessionStorage.setItem('locked','1'));
  await page.goto('https://flurbo.singu.online/portfolio');await page.getByText('Across 2 trading wallets',{exact:true}).waitFor();await page.getByRole('heading',{name:'Your shares',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Connect MetaMask',exact:true}).count(),0);
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
