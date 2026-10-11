import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {encodeFunctionData,parseAbi} from 'viem';
import {owner} from './pool-fixture.ts';
import {TESTNET} from '../server/network.mjs';

test('Mera keeps linked wallets across pages and reload, while MetaMask restores silently and can switch',{skip:!process.env.FLURBO_TEST_PLAYWRIGHT},async()=>{
 const {chromium}=await import(pathToFileURL(process.env.FLURBO_TEST_PLAYWRIGHT!).href);
 const browser=await chromium.launch({headless:true,executablePath:process.env.FLURBO_TEST_BROWSER});
 const login='0x'+'99'.repeat(20),second='0x'+'ab'.repeat(20),requests:any[]=[],errors:string[]=[];
 const pool='0x'+'22'.repeat(20),now=Math.floor(Date.now()/1000),closesAt=now+86400;
 const markets=[0,1].map(eventIndex=>({id:`${pool}-${eventIndex}`,pool,poolTitle:'Practice',eventIndex,question:`Test event ${eventIndex+1}`,route:'mechanical',closesAt,observationEndsAt:closesAt+3600}));
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
   if(p==='/api/market-directory')return route.fulfill({json:{schema:'flurbo.market-directory.v1',markets:[],oracleMarkets:[],hybridMarkets:markets}});
   if(p==='/api/network')return route.fulfill({json:{...TESTNET,flurboFaucet:true}});
   if(p==='/api/rpc')return route.fulfill({json:{result:'0x0'}});
   const market=markets.find(m=>p.startsWith(`/api/hybrid/${m.id}`));
   if(market&&p.endsWith('/market'))return route.fulfill({json:{schema:'flurbo.hybrid-market.v1',id:market.id,pool,marketNow:now,funded:true,resolved:false,prices:{yes:'500000',no:'500000'}}});
   if(market&&p.endsWith('/price-history'))return route.fulfill({json:{pool,sampling:'current',points:[]}});
   if(market&&p.endsWith('/action')){
    const input=route.request().postDataJSON();requests.push(input);
    const quantity=BigInt(input.input?.quantity||0),cost=quantity/2n,maximum=cost+(cost+199n)/200n;
    if(input.action==='quote')return route.fulfill({json:{action:'quote',buyAtoms:cost.toString(),maxCostAtoms:maximum.toString(),sellAtoms:null,minProceedsAtoms:null,cashAtoms:'10000000',allowanceAtoms:'0',holdingsAtoms:'0'}});
    const data=input.action==='buy'?encodeFunctionData({abi:parseAbi(['function buy(uint32,uint256,uint128,uint128,uint256) returns (uint128)']),functionName:'buy',args:[1,2n,quantity,maximum,BigInt(now+120)]}):'0x1234';
    return route.fulfill({json:{action:input.action,amountAtoms:maximum.toString(),maxCostAtoms:maximum.toString(),reason:`${input.action} shares`,transaction:{chainId:10143,from:input.owner,to:pool,data,value:'0x0'}}});
   }
   if(market&&p===`/api/hybrid/${market.id}`)return route.fulfill({json:{...market,schema:'flurbo.hybrid-snapshot.v1',resolver:pool,eventHash:'0x'+'33'.repeat(32),rulesHash:'0x'+'55'.repeat(32),adapter:pool,
    source:{adapter:'evm-rpc.v1',publisher:'Test RPC'},marketNow:now,funded:true,resolved:false,delivered:false,assertionDeadline:now+14400+86400,reportDeadline:now+2*86400,bondAtoms:'1000000',
    phase:0,proposal:0,counter:0,result:0,challengeUntil:0,arbitrationUntil:0,requestId:'0x'+'00'.repeat(32),sourceCaseId:'0x'+'00'.repeat(32),proposalEvidenceURI:null,reality:null,
    user:url.searchParams.has('wallet')?{wallet:url.searchParams.get('wallet'),noShares:'0',yesShares:'0',cashAtoms:'10000000',allowanceAtoms:'0',bondAllowanceAtoms:'0',bondCreditsAtoms:'0'}:null}});
   if(p.startsWith(`/api/hybrid/pool/${pool}/`)){
    if(p.endsWith('/account'))return route.fulfill({json:{schema:'flurbo.hybrid-portfolio-account.v1',manifest:{pool,resolver:pool,chainId:10143,publication:{draft:{title:'Practice',closesAt,
     events:markets.map((m,i)=>({id:`event-${i}`,question:m.question,route:'mechanical',observationEndsAt:m.observationEndsAt}))}}},snapshot:{blockNumber:'100',blockHash:'0x'+'44'.repeat(32),timestamp:now},claimScopes:[]}});
    if(p.endsWith('/positions')){const input=route.request().postDataJSON();return route.fulfill({json:{schema:'flurbo.hybrid-portfolio-positions.v1',owner:input.owner,snapshot:{blockNumber:'100',blockHash:'0x'+'44'.repeat(32),timestamp:now},resolved:false,rows:input.claims.map((c:any)=>({scope:c.scope,mask:c.mask,quantity:'0',payoutAtoms:null}))}});}
    return route.fulfill({json:{complete:true,through:100,target:100,logs:[]}});
   }
   if(p.startsWith('/api/'))return route.fulfill({status:503,json:{error:'Fixture unavailable'}});
   const file=p.startsWith('/assets/')?p.slice(1):'index.html';return route.fulfill({body:await readFile(new URL('../dist/'+file,import.meta.url)),contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});
  });
  const review=async()=>{
   const ticket=page.getByRole('region',{name:'Trade this market'});
   await ticket.getByRole('button',{name:'Review AUSD approval'}).click();
   await ticket.getByRole('button',{name:'Allow payment',exact:true}).waitFor();
  };
  for(const url of [`/markets/hybrid/${pool}/0`,`/markets/hybrid/${pool}/1`,'/fund','/access']){
   await page.goto('https://flurbo.singu.online'+url);await page.getByRole('button',{name:'Switch wallet',exact:true}).waitFor();
   assert.equal(await page.evaluate(()=>sessionStorage.getItem('connects')),null);
  }
  await page.getByText('2 linked wallets',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Switch wallet',exact:true}).click();
  await page.getByText(`Active for trading: ${second.slice(0,8)}...${second.slice(-6)}`,{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>sessionStorage.getItem('connects')),'1');
  await page.goto(`https://flurbo.singu.online/markets/hybrid/${pool}/0`);await review();assert.equal(requests.at(-1).owner.toLowerCase(),second);
  await page.reload();await review();assert.equal(await page.evaluate(()=>sessionStorage.getItem('connects')),'1');
  await page.evaluate(()=>sessionStorage.setItem('locked','1'));
  await page.goto('https://flurbo.singu.online/portfolio');await page.getByText('Across 2 trading wallets',{exact:true}).waitFor();await page.getByRole('heading',{name:'Your shares',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Connect MetaMask',exact:true}).count(),0);
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
