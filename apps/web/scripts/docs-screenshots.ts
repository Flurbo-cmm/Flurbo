// Captures every screenshot shown on /docs from the production bundle (dist) with sample data.
// Nothing reaches a network: the agent API and MetaMask are the in-process fixtures the browser tests use, and the
// market pages read the example pools in scripts/docs-market-fixture.ts.
//
//   npm run build
//   FLURBO_TEST_PLAYWRIGHT=<playwright-core/index.mjs> FLURBO_TEST_BROWSER=<chrome> \
//     node --experimental-strip-types scripts/docs-screenshots.ts
//
// Output: src/pages/docs-media/*.png, imported by Docs.tsx.
import {mkdir,readFile} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {decodeFunctionData,encodeFunctionResult} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {hybridPoolService} from '../server/hybrid-pool-service.mjs';
import {pilotPoolAbi} from '../shared/pilot.mjs';
import {TESTNET} from '../server/network.mjs';
import {owner,hash,code} from '../tests/pool-fixture.ts';
import {setup,alice,origin,forecast} from '../tests/agent-fixture.ts';
import {marketFixture,POOLS,TRADER} from './docs-market-fixture.ts';

const OUT=new URL('../src/pages/docs-media/',import.meta.url);
const at=Math.floor(Date.now()/1000);
const s=setup({at,links:[owner]});
const {manifest,namespace}=s.f,pool=manifest.pool;
manifest.publication.draft.title='Example: releases and network activity';
['Will go-ethereum publish stable release v1.17.7 by 7 October 2026?','Will reth publish stable release v2.6.1 by 7 October 2026?',
  'Will Monad mainnet record at least 5,100 transactions in the sampled blocks on 1 October 2026?']
  .forEach((question,i)=>{manifest.publication.draft.events[i].question=question;});
['https://github.com/ethereum/go-ethereum/releases','https://github.com/paradigmxyz/reth/releases','https://rpc.monad.xyz/']
  .forEach((url,i)=>{manifest.publication.draft.events[i].source={...manifest.publication.draft.events[i].source,referenceUrl:url};});

// Sample prices: YES chances per question, and each claim priced from them, so quotes look like a real pool.
const yes=[0.62,0.41,0.55];
function chance(scope:number,mask:bigint){
  const legs=[0,1,2].filter(i=>scope&(1<<i));let total=0;
  for(let state=0;state<1<<legs.length;state++)if(mask&(1n<<BigInt(state)))total+=legs.reduce((p,e,j)=>p*(state&(1<<j)?yes[e]:1-yes[e]),1);
  return total;
}
const base=s.f.rpc;
const rpc=async(method:string,params:any[]=[])=>{
  if(method==='eth_call'&&params[0]?.to===pool&&!params[0].from){
    const {functionName,args}=decodeFunctionData({abi:pilotPoolAbi,data:params[0].data}) as {functionName:string;args:any[]};
    if(functionName==='quoteBuy'||functionName==='quoteSell'){
      const p=chance(Number(args[0]),BigInt(args[1]))*(functionName==='quoteBuy'?1.01:0.99);
      return encodeFunctionResult({abi:pilotPoolAbi,functionName,result:BigInt(Math.round(p*Number(args[2])))});
    }
  }
  return base(method,params);
};
s.f.service=hybridPoolService({manifest,rpc,now:()=>at});

// The agent's trading wallet.
const agentKey='0x'+'5e'.repeat(32) as `0x${string}`,agentWallet=privateKeyToAccount(agentKey).address.toLowerCase();

// One registered agent with a wallet, a credential, a running heartbeat and two decisions.
const created=(await s.call(alice,'POST','/api/agents',{kind:'runtime',name:'release-watcher',markets:[namespace]})).body;
const challenge=(await s.call(alice,'POST',`/api/agents/${created.id}/wallet/challenge`,{wallet:agentWallet})).body;
await s.call(alice,'POST',`/api/agents/${created.id}/wallet/verify`,{id:challenge.id,signature:await privateKeyToAccount(agentKey).signMessage({message:challenge.message})});
const {token}=(await s.call(alice,'POST',`/api/agents/${created.id}/credentials`,{scopes:['markets:read','wallet:read','runtime:report','executions:report'],label:'laptop'})).body;
const runtime=(method:string,path:string,body:unknown)=>s.api.runtime({method,path:'/api/agent-runtime/v1/'+path,headers:{authorization:'Bearer '+token,'flurbo-agent-protocol':'1'},body:JSON.stringify(body)});
await runtime('POST','heartbeat',{runtimeId:'rt-docs',sdk:{language:'python',version:'0.2.0'},mode:'paper',state:'running',policy:{hash:'a'.repeat(64),flurboVersion:1,summary:{maxTradeCostAtoms:'2000000',totalAtoms:'20000000'}},pending:0,startedAt:at-600});
const evidence=[{id:'src-1',title:'https://github.com/ethereum/go-ethereum/releases',source:'github.com',url:'https://github.com/ethereum/go-ethereum/releases',observedAt:new Date((at-120)*1000).toISOString(),note:'Release page.'},
  {id:'src-2',title:'https://github.com/paradigmxyz/reth/releases',source:'github.com',url:'https://github.com/paradigmxyz/reth/releases',observedAt:new Date((at-120)*1000).toISOString(),note:'Release page.'}];
for(const [i,outcome] of [[0,'abstain'],[1,'paper']] as const)await runtime('POST','decisions',{schema:'flurbo.agent-runtime-decision.v1',decisionId:'d-docs-'+i,namespace,createdAt:at-300+i*240,outcome,
  reasons:outcome==='abstain'?['edge_below_threshold']:[],provenance:{kind:'model',name:'anthropic/your-model'},
  ...(outcome==='paper'?{forecast:forecast(pool,{evidence,createdAt:new Date((at-61)*1000).toISOString()},at),candidate:{claim:{scope:1,mask:'2'},quoteAtoms:'626200'}}:{})});

const {chromium}=await import(pathToFileURL(process.env.FLURBO_TEST_PLAYWRIGHT!).href);
const browser=await chromium.launch({headless:true,executablePath:process.env.FLURBO_TEST_BROWSER});
const json=(route:any,body:unknown,status=200)=>route.fulfill({status,json:body});
async function open(session:boolean){
  const page=await browser.newPage({viewport:{width:1280,height:2600},deviceScaleFactor:2});
  await page.addInitScript(({owner,hash,code}:any)=>{
    (window as any).ethereum={isMetaMask:true,on:()=>{},removeListener:()=>{},request:async({method}:any)=>{
      if(['eth_accounts','eth_requestAccounts'].includes(method))return [owner];
      if(method==='eth_chainId')return '0x279f';
      if(method==='wallet_requestPermissions')return [];
      if(method==='eth_getBlockByNumber')return {number:'0x65',hash};
      if(method==='eth_getCode')return code;
      if(method==='eth_estimateGas')return '0x186a0';
      if(method==='eth_gasPrice')return '0x3b9aca00';
      if(method==='eth_getBalance')return '0x429d069189e0000';
      if(method==='eth_getTransactionCount')return 7;
      if(method==='eth_call')return '0x';
      throw new Error(method);
    }};
  },{owner,hash,code});
  await page.route('**/*',async(route:any)=>{
    const url=new URL(route.request().url()),p=url.pathname,method=route.request().method(),body=method==='POST'?route.request().postDataJSON():undefined;
    if(p==='/api/auth/session')return json(route,{session:session?{address:alice,method:'passkey',expiresAt:Date.now()+3600_000}:null});
    if(p==='/api/account/access')return json(route,{approved:true,nativeApplications:true,testingTools:false,applicationUrl:null});
    if(p==='/api/account/application')return json(route,{application:{account:alice,email:'you@example.com',state:'approved',verified:true,revision:1,createdAt:new Date().toISOString(),notification:'none'}});
    if(p==='/api/account/wallets')return json(route,{account:alice,wallets:[owner]});
    if(p==='/api/account/notifications')return json(route,{enabled:true,email:'you@example.com',preferences:{payouts:true,challenges:true,observations:true,closing:false}});
    if(p==='/api/market-directory')return json(route,{schema:'flurbo.market-directory.v1',markets:[{namespace,label:'Example markets',pool,closesAt:manifest.publication.draft.closesAt}],oracleMarkets:[],hybridMarkets:[]});
    if(p==='/api/network')return json(route,{...TESTNET,flurboFaucet:true,starterMon:'0.5'});
    if(p==='/api/fund/starter')return json(route,{status:'sent',amountMon:'0.5'});
    if(p==='/api/rpc'){
      const {method:m,params}=body;
      const result=m==='eth_getBalance'?'0x429d069189e0000':m==='eth_call'?(params[0].data.startsWith('0x70a08231')?'0x2faf080':'0x0'):m==='eth_getBlockByNumber'?{hash,number:'0x64'}:'0x0';
      return json(route,{result});
    }
    if(p===`/api/${namespace}/markets`)return json(route,await s.f.service.markets());
    if(p==='/api/agents'||p.startsWith('/api/agents/')){const result=await s.call(alice,method,p,body);return json(route,result.body,result.status);}
    if(p.startsWith('/api/'))return json(route,{error:'Not part of the docs fixture'},503);
    const file=p.startsWith('/assets/')?p.slice(1):'index.html';
    return route.fulfill({body:await readFile(new URL('../dist/'+file,import.meta.url)),contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.woff2')?'font/woff2':file.endsWith('.png')?'image/png':file.endsWith('.svg')?'image/svg+xml':'text/html'});
  });
  return page;
}
async function ready(page:any){
  // The sticky header would cover the top of each capture.
  await page.addStyleTag({content:'.site-header{position:static !important}'}).catch(()=>{});
  await page.waitForFunction(()=>{const root=document.querySelector('.app-root') as HTMLElement|null;return !!root&&!root.inert&&!document.querySelector('.contour-loader');},null,{timeout:30000});
  await page.waitForTimeout(600);
}
async function shot(page:any,name:string,target:any,pad=12){
  await target.scrollIntoViewIfNeeded();await page.waitForTimeout(300);
  const box=await target.boundingBox();if(!box)throw new Error('Nothing to capture for '+name);
  await page.screenshot({path:fileURLToPath(new URL(name+'.png',OUT)),clip:{x:Math.max(0,box.x-pad),y:Math.max(0,box.y-pad),width:box.width+pad*2,height:box.height+pad*2}});
  console.log('wrote',name);
}

// From the top of one element to the bottom of another, across the width of a container.
async function shotRange(page:any,name:string,container:any,first:any,last:any,pad=12){
  const [c,a,b]=await Promise.all([container,first,last].map((l:any)=>l.boundingBox()));
  await page.screenshot({path:fileURLToPath(new URL(name+'.png',OUT)),clip:{x:c.x-pad,y:a.y-pad,width:c.width+pad*2,height:b.y+b.height-a.y+pad*2}});
  console.log('wrote',name);
}

const markets=marketFixture(at);
async function openMarkets(viewport={width:1280,height:1000}){
  const page=await browser.newPage({viewport,deviceScaleFactor:2});
  await page.addInitScript((wallet:string)=>{
    (window as any).ethereum={isMetaMask:true,on:()=>{},removeListener:()=>{},request:async({method}:any)=>{
      if(['eth_accounts','eth_requestAccounts'].includes(method))return [wallet];
      if(method==='eth_chainId')return '0x279f';
      if(method==='wallet_requestPermissions')return [];
      if(method==='eth_getTransactionReceipt')return null;
      if(method==='eth_sendTransaction')throw new Error('The wallet closed before it returned a transaction');
      throw new Error(method);
    }};
  },TRADER);
  await page.route('**/*',async(route:any)=>{
    const url=new URL(route.request().url()),p=url.pathname,method=route.request().method(),body=method==='POST'?route.request().postDataJSON():undefined;
    if(p==='/api/auth/session')return json(route,{session:{address:alice,method:'passkey',expiresAt:Date.now()+3600_000}});
    if(p==='/api/account/access')return json(route,{approved:true,nativeApplications:true,testingTools:false,applicationUrl:null});
    if(p==='/api/account/wallets'||p==='/api/account/portfolio-sources')return json(route,{account:alice,wallets:[TRADER],agentWallets:[]});
    const served=p.startsWith('/api/')?markets.serve(p,url.searchParams,body):undefined;
    if(served!==undefined)return json(route,served);
    if(p.startsWith('/api/'))return json(route,{error:'Not part of the docs fixture'},503);
    const file=p.startsWith('/assets/')?p.slice(1):'index.html';
    return route.fulfill({body:await readFile(new URL('../dist/'+file,import.meta.url)),contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.woff2')?'font/woff2':file.endsWith('.png')?'image/png':file.endsWith('.svg')?'image/svg+xml':'text/html'});
  });
  // The sticky header would sit over the top of each market capture.
  await page.addInitScript(()=>{addEventListener('DOMContentLoaded',()=>{const style=document.createElement('style');style.textContent='.site-header{display:none !important}';document.head.append(style);});});
  return page;
}
const marketPath=(pool:string,event:number,query='')=>origin+'/markets/hybrid/'+pool+'/'+event+query;

await mkdir(OUT,{recursive:true});
try{
  // Sign-up with a passkey name.
  let page=await open(false);await page.goto(origin+'/signup');await ready(page);
  await shotRange(page,'signup',page.getByRole('heading',{level:1}).locator('xpath=..'),page.getByText('Back to flurbo'),page.locator('.auth-more'),24);await page.close();

  // Account approved, with the linked trading wallet.
  page=await open(true);await page.goto(origin+'/access');await ready(page);await page.getByText('Access approved').first().waitFor();
  await shot(page,'account-approved',page.locator('main section, main article').first());
  await page.locator('#notices').waitFor();await shot(page,'notices',page.locator('#notices'));await page.close();

  // Test funds.
  page=await open(true);await page.goto(origin+'/fund');await ready(page);await page.getByText('Trading balance').waitFor();
  // main fills the tall capture window, so stop at the last step instead of its bottom edge.
  await shotRange(page,'test-funds',page.locator('main'),page.getByText('Back to markets'),page.getByRole('button',{name:'Request test AUSD'}),24);await page.close();

  // Agents: register, setup, research settings, live confirmation, activity.
  page=await open(true);await page.goto(origin+'/agents');await ready(page);
  await shot(page,'agents-register',page.getByRole('form',{name:'Register an agent'}));
  await page.goto(origin+'/agents/'+created.id);await ready(page);
  await page.getByRole('button',{name:'Setup',exact:true}).click();
  await shot(page,'agent-wallet',page.getByRole('region',{name:'Agent wallet'}));
  await shot(page,'agent-run',page.getByRole('region',{name:'Run the agent'}));
  await shot(page,'agent-research',page.getByRole('region',{name:'Research settings'}));
  await page.getByRole('button',{name:'Settings',exact:true}).click();
  await page.getByRole('button',{name:'Allow live testnet trades'}).click();
  await page.waitForTimeout(400);
  await shot(page,'agent-live',page.getByRole('dialog',{name:'Allow this agent to send live testnet trades?'}));
  await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'Activity',exact:true}).click();
  await page.locator('details.agents-assumptions').filter({hasText:'Evidence'}).first().evaluate((d:any)=>{d.open=true;});
  await shot(page,'agent-activity',page.getByRole('region',{name:'Decisions'}));
  await page.close();

  // The market board, every status shown.
  page=await openMarkets({width:1000,height:836});await page.goto(origin+'/markets?status=all');await ready(page);
  await page.locator('.market-card .tile-prices').first().waitFor();await page.waitForTimeout(800);
  await shotRange(page,'markets',page.locator('main.board-page'),page.locator('.board-subnav'),page.locator('.market-card').last(),8);await page.close();

  // An open market: the page head and chart, then the ticket with a live quote, the approval and a wallet that returns no hash.
  page=await openMarkets({width:1100,height:1400});await page.goto(marketPath(POOLS.rates,0,'?shares=5'));await ready(page);
  const ticket=page.getByRole('region',{name:'Trade this market'});
  await ticket.getByText('Review AUSD approval').waitFor();await page.waitForTimeout(1200);
  await shotRange(page,'market-page',page.locator('main.market-page'),page.locator('.market-topbar'),page.locator('.market-primary [role="tablist"]').first(),16);
  await shot(page,'ticket-buy',page.locator('section.detail-trade'));
  await ticket.getByRole('button',{name:'Review AUSD approval'}).click();
  await ticket.getByRole('heading',{name:'Step 1 of 2: allow this payment'}).waitFor();await page.waitForTimeout(500);
  await shot(page,'ticket-approve',page.locator('dialog[open]'),0);
  await ticket.getByRole('button',{name:'Allow payment',exact:true}).click();
  await ticket.getByRole('button',{name:'Nothing was sent'}).waitFor();await page.waitForTimeout(400);
  await shot(page,'ticket-no-hash',page.locator('dialog[open]'),0);
  await ticket.getByRole('button',{name:'Nothing was sent'}).click();await page.close();

  // A combined prediction in the ticket.
  page=await openMarkets({width:1280,height:1600});await page.goto(marketPath(POOLS.rates,0,'?shares=4&other=1&otherAnswer=yes&rule=AND'));await ready(page);
  const combo=page.getByRole('region',{name:'Trade this market'});
  await combo.locator('details.oracle-combination').evaluate((d:any)=>{d.open=true;});
  await combo.getByText('Review AUSD approval').waitFor();await page.waitForTimeout(600);
  await shot(page,'ticket-combination',page.locator('section.detail-trade'));await page.close();

  // What if: the linked tab with the pool comparison open, then the proof tab.
  page=await openMarkets({width:1280,height:1800});await page.goto(marketPath(POOLS.rates,0,'?tab=linked'));await ready(page);
  await page.locator('details.hybrid-connect > summary').click();
  await page.getByText('All four combinations').waitFor();
  await page.locator('details.hybrid-connect details.disclosure').evaluate((d:any)=>{d.open=true;});await page.waitForTimeout(500);
  await shot(page,'what-if',page.locator('details.hybrid-connect'));
  await page.getByRole('tab',{name:'Proof'}).click();await page.waitForTimeout(500);
  await shot(page,'proof',page.locator('.proof-panel'));await page.close();

  // Build your thesis with three estimates entered.
  page=await openMarkets({width:1280,height:1700});await page.goto(marketPath(POOLS.rates,0,'/thesis'));await ready(page);
  await page.getByText('Four possible outcomes').waitFor();await page.waitForTimeout(800);
  const beliefs=page.locator('label.hybrid-belief input[placeholder="Your estimate"]');
  for(const [i,value] of ['65','85','40'].entries())await beliefs.nth(i).fill(value);
  await page.getByLabel('Shares').fill('5');
  await page.locator('dt',{hasText:'Your expected net'}).locator('xpath=following-sibling::dd').filter({hasText:'test AUSD'}).waitFor();await page.waitForTimeout(900);
  await shot(page,'thesis',page.locator('.hybrid-thesis-grid'));await page.close();

  // Settlement: a source-read answer in its challenge window, and a Reality.eth answer under Kleros review.
  page=await openMarkets({width:1280,height:2200});await page.goto(marketPath(POOLS.activity,0));await ready(page);
  await page.getByRole('heading',{name:'Challenge this answer'}).first().waitFor();await page.waitForTimeout(500);
  await shot(page,'settlement-timeline',page.getByRole('region',{name:'Settlement timeline'}));await page.close();
  page=await openMarkets({width:1280,height:2600});await page.goto(marketPath(POOLS.releases,0));await ready(page);
  await page.getByText('Kleros case #42',{exact:false}).first().waitFor();await page.waitForTimeout(500);
  await shot(page,'settlement-reality',page.getByRole('region',{name:'Settlement timeline'}));await page.close();

  // A settled market: collect in the ticket.
  page=await openMarkets({width:1280,height:1400});await page.goto(marketPath(POOLS.blocks,0));await ready(page);
  await page.getByRole('button',{name:'Collect yes payout'}).waitFor();await page.waitForTimeout(400);
  await shot(page,'collect',page.locator('section.detail-trade'));await page.close();

  // Portfolio with an individual, a combined and a settled position.
  page=await openMarkets({width:1280,height:1400});await page.goto(origin+'/portfolio');await ready(page);
  await page.locator('.unified-holdings tbody tr').nth(2).waitFor();await page.waitForTimeout(800);
  await shot(page,'portfolio',page.locator('.unified-holdings').first());await page.close();
}finally{await browser.close();}

// Display sizes for Docs: half the captured pixels, read from each PNG header (width and height at bytes 16-23).
const {readdir,writeFile}=await import('node:fs/promises');
const sizes:string[]=[];
for(const file of (await readdir(OUT)).filter(f=>f.endsWith('.png')).sort()){
  const png=await readFile(new URL(file,OUT));
  sizes.push(`  '${file.slice(0,-4)}': { width: ${Math.round(png.readUInt32BE(16)/2)}, height: ${Math.round(png.readUInt32BE(20)/2)} },`);
}
await writeFile(new URL('sizes.ts',OUT),`// Generated by scripts/docs-screenshots.ts: display size of each screenshot, half its captured pixels.\nexport const SHOT_SIZE: Record<string, { width: number; height: number }> = {\n${sizes.join('\n')}\n};\n`);
console.log('wrote sizes');
