// Captures the screenshots shown on /docs from the production bundle (dist) with sample data. Nothing reaches a
// network: the pool, agent API and MetaMask are the same in-process fixtures the browser tests use.
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
import {pilotService} from '../server/pilot.mjs';
import {pilotPoolAbi} from '../shared/pilot.mjs';
import {TESTNET} from '../server/network.mjs';
import {assessSemantics} from '../server/semantic-validation.mjs';
import {owner,hash,code} from '../tests/pilot-fixture.ts';
import {setup,alice,origin,forecast} from '../tests/agent-fixture.ts';

const OUT=new URL('../src/pages/docs-media/',import.meta.url);
const at=Math.floor(Date.now()/1000);
const s=setup({at,links:[owner]});
const {manifest}=s.f,pool=manifest.pool;
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
s.f.service=pilotService({manifest,rpc,now:()=>at});

// Holdings: the member's own wallet and one agent wallet.
const agentKey='0x'+'5e'.repeat(32) as `0x${string}`,agentWallet=privateKeyToAccount(agentKey).address.toLowerCase();
const held:Record<string,Record<string,string>>={[owner]:{'1:2':'3000000','2:1':'2000000','3:8':'1000000'},[agentWallet]:{'1:2':'1000000'}};

// One registered agent with a wallet, a credential, a running heartbeat and two decisions.
const created=(await s.call(alice,'POST','/api/agents',{kind:'runtime',name:'release-watcher',markets:['pilot']})).body;
const challenge=(await s.call(alice,'POST',`/api/agents/${created.id}/wallet/challenge`,{wallet:agentWallet})).body;
await s.call(alice,'POST',`/api/agents/${created.id}/wallet/verify`,{id:challenge.id,signature:await privateKeyToAccount(agentKey).signMessage({message:challenge.message})});
const {token}=(await s.call(alice,'POST',`/api/agents/${created.id}/credentials`,{scopes:['markets:read','wallet:read','runtime:report','executions:report'],label:'laptop'})).body;
const runtime=(method:string,path:string,body:unknown)=>s.api.runtime({method,path:'/api/agent-runtime/v1/'+path,headers:{authorization:'Bearer '+token,'flurbo-agent-protocol':'1'},body:JSON.stringify(body)});
await runtime('POST','heartbeat',{runtimeId:'rt-docs',sdk:{language:'python',version:'0.2.0'},mode:'paper',state:'running',policy:{hash:'a'.repeat(64),flurboVersion:1,summary:{maxTradeCostAtoms:'2000000',totalAtoms:'20000000'}},pending:0,startedAt:at-600});
const evidence=[{id:'src-1',title:'https://github.com/ethereum/go-ethereum/releases',source:'github.com',url:'https://github.com/ethereum/go-ethereum/releases',observedAt:new Date((at-120)*1000).toISOString(),note:'Release page.'},
  {id:'src-2',title:'https://github.com/paradigmxyz/reth/releases',source:'github.com',url:'https://github.com/paradigmxyz/reth/releases',observedAt:new Date((at-120)*1000).toISOString(),note:'Release page.'}];
for(const [i,outcome] of [[0,'abstain'],[1,'paper']] as const)await runtime('POST','decisions',{schema:'flurbo.agent-runtime-decision.v1',decisionId:'d-docs-'+i,namespace:'pilot',createdAt:at-300+i*240,outcome,
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
    if(p==='/api/account/portfolio-sources')return json(route,{account:alice,wallets:[owner],agentWallets:[agentWallet],agentExecutions:[{agentId:created.id,agentName:'release-watcher',namespace:'pilot',pool,owner:agentWallet,
      hash:'0x'+'7a'.repeat(32),block:101,timestamp:at-200,action:'Buy',scope:1,mask:'2',quantity:'1000000',cash:'626200'}]});
    if(p==='/api/market-directory')return json(route,{schema:'flurbo.market-directory.v1',active:'pilot',markets:[{namespace:'pilot',label:'Example markets',pool,closesAt:manifest.publication.draft.closesAt}]});
    if(p==='/api/network')return json(route,{...TESTNET,flurboFaucet:true,starterMon:'0.5'});
    if(p==='/api/fund/starter')return json(route,{status:'sent',amountMon:'0.5'});
    if(p==='/api/rpc'){
      const {method:m,params}=body;
      const result=m==='eth_getBalance'?'0x429d069189e0000':m==='eth_call'?(params[0].data.startsWith('0x70a08231')?'0x2faf080':'0x0'):m==='eth_getBlockByNumber'?{hash,number:'0x64'}:'0x0';
      return json(route,{result});
    }
    if(p==='/api/pilot/markets')return json(route,await s.f.service.markets());
    if(p==='/api/pilot/status')return json(route,await s.f.service.status(url.searchParams.get('wallet')||undefined));
    if(p.startsWith('/api/pilot/account'))return json(route,await s.f.service.account(url.searchParams.get('wallet')||owner));
    if(p==='/api/pilot/prepare')return json(route,await s.f.service.prepare(body));
    if(p==='/api/pilot/validate-trade')return json(route,assessSemantics(manifest,body));
    if(p==='/api/pilot/positions')return json(route,{owner:body.owner,snapshot:{blockNumber:'100'},rows:body.claims.map((c:any)=>({...c,quantity:held[body.owner?.toLowerCase()]?.[`${c.scope}:${c.mask}`]??'0',payoutAtoms:null}))});
    if(p==='/api/pilot/position')return json(route,{quantity:held[owner][`${body.scope}:${body.mask}`]??'0',payoutAtoms:null});
    if(p==='/api/pilot/history'||p==='/api/pilot/collected-payouts')return json(route,{complete:true,through:100,target:100,logs:[]});
    if(p==='/api/pilot/price-history'){
      const end=at;return json(route,{pool,sampling:'current',points:[0,1,2,3,4,5].map(i=>({timestamp:end-3000+i*600,blockNumber:String(90+i),prices:[0,1,2].map(event=>({event,yes:String(Math.round((yes[event]-0.05+i*0.01)*1e6)),no:String(Math.round((1-yes[event]+0.05-i*0.01)*1e6))}))}))});
    }
    if(p==='/api/pilot/claim-analytics'){const snapshot=(await s.f.service.status()).snapshot;return json(route,{schema:'flurbo.claim-analytics.v1',model:'bounded-lmsr-enumeration-v1',chainId:10143,pool,rulesHash:manifest.rulesHash,...body,snapshot,expiresAt:snapshot.timestamp+60,stateDigest:'ab'.repeat(32),unit:'tenths_of_percentage_point',closed:false,values:{market:254,independent:254,difference:0}});}
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

await mkdir(OUT,{recursive:true});
try{
  // Sign-up with a passkey name.
  let page=await open(false);await page.goto(origin+'/signup');await ready(page);
  await shotRange(page,'signup',page.getByRole('heading',{level:1}).locator('xpath=..'),page.getByText('Back to flurbo'),page.getByText('Check device support'),24);await page.close();

  // Account approved, with the linked trading wallet.
  page=await open(true);await page.goto(origin+'/access');await ready(page);await page.getByText('Access approved').first().waitFor();
  await shot(page,'account-approved',page.locator('main section, main article').first());await page.close();

  // Test funds.
  page=await open(true);await page.goto(origin+'/fund');await ready(page);await page.getByText('Trading balance').waitFor();
  // main fills the tall capture window, so stop at the last step instead of its bottom edge.
  await shotRange(page,'test-funds',page.locator('main'),page.getByText('Back to markets'),page.getByRole('button',{name:'Request test AUSD'}),24);await page.close();

  // Markets list.
  page=await open(true);await page.goto(origin+'/markets');await ready(page);await page.getByText(manifest.publication.draft.events[0].question.slice(0,30)).first().waitFor();
  await shotRange(page,'markets',page.locator('main'),page.getByRole('heading',{level:1}),page.getByText('How combined predictions work'),24);

  // One question: the trade ticket with its first step, then a combination, then the settlement timeline.
  await page.goto(origin+'/markets/pilot/0');await ready(page);
  const ticket=page.locator('.trade-ticket, aside').filter({hasText:'Buy or sell'}).first();
  await page.getByText('Step 1 of 2: allow this payment').waitFor({timeout:20000});
  await shotRange(page,'ticket-buy',ticket,ticket.getByText('Your prediction',{exact:true}),ticket.getByRole('button',{name:'Allow payment'}),10);
  await ticket.getByRole('button',{name:/Combine with another prediction/}).click();
  const builder=page.getByRole('region',{name:'Combined prediction builder'});
  await builder.locator('input[type=checkbox]').nth(1).check();
  await builder.locator('input[type=radio][value=OR]').check();
  await page.getByText('Step 1 of 2: allow this payment').waitFor({timeout:20000});
  await builder.locator('details').evaluateAll((list:any[])=>list.forEach(d=>{d.open=false;}));
  await shot(page,'ticket-combination',builder);
  await shot(page,'settlement-timeline',page.locator('section.detail-settlement'));
  await page.close();

  // Portfolio with your holdings and an agent's holding on separate rows.
  page=await open(true);await page.goto(origin+'/portfolio');await ready(page);await page.getByText('Via release-watcher').first().waitFor({timeout:20000});
  await shot(page,'portfolio',page.locator('.unified-holdings'));await page.close();

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
  await shot(page,'agent-live',page.getByRole('region',{name:'Controls'}));
  await page.getByRole('button',{name:'Activity',exact:true}).click();
  await page.locator('details.agents-assumptions').filter({hasText:'Evidence'}).first().evaluate((d:any)=>{d.open=true;});
  await shot(page,'agent-activity',page.getByRole('region',{name:'Decisions'}));
  await page.close();
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
