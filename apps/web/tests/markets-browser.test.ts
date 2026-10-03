import {assessSemantics} from '../server/semantic-validation.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { pilotFixture, owner, hash, code } from './pilot-fixture.ts';

for(const namespace of ['practice-'+'22'.repeat(20)])test('consumer markets preserve wallet confirmation flow for '+namespace,{skip:!process.env.FLURBO_TEST_PLAYWRIGHT},async()=>{
  const {chromium}=await import(pathToFileURL(process.env.FLURBO_TEST_PLAYWRIGHT!).href);
  const browser=await chromium.launch({headless:true,executablePath:process.env.FLURBO_TEST_BROWSER});
  const loginAddress='0x'+'99'.repeat(20);
  const f=pilotFixture(Math.floor(Date.now()/1000),4);
  f.manifest.publication.draft.events.forEach((e:any,i:number)=>e.question=['Will the night market open?','Will the concert sell out?','Will it rain on Saturday?','Will the new cafe open?'][i]);
  f.manifest.publication.reviewerControl='single-operator';
  {f.manifest.publication.mode='rehearsal';f.manifest.publication.draft.title='Public rehearsal: scripted settlement checks';}
  let login=true,reads=0,historyReads=0,linked=false;const preparedQuantities:string[]=[];const preparedClaims:any[]=[];const errors:string[]=[];
  let heldCombinationQuote:Promise<void>|null=null;
  try{
    const page=await browser.newPage({viewport:{width:1440,height:1000}});
    await page.clock.install();
    page.on('pageerror',(error:Error)=>errors.push(error.message));
    await page.addInitScript(({owner,hash,code,namespace}:any)=>{
      const listeners=new Map<string,Set<()=>void>>();
      (window as any).walletEvent=(name:string)=>listeners.get(name)?.forEach(fn=>fn());
      (window as any).ethereum={isMetaMask:true,
        on:(name:string,fn:()=>void)=>{if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name)!.add(fn);},
        removeListener:(name:string,fn:()=>void)=>listeners.get(name)?.delete(fn),
        request:async({method}:any)=>{
        if(method==='eth_requestAccounts'&&sessionStorage.getItem('wallet.rejectConnect'))throw Object.assign(new Error('Rejected'),{code:4001});
        if(method==='wallet_requestPermissions')return [];
        if(method==='personal_sign'){if(sessionStorage.getItem('wallet.rejectLink'))throw Error('Link signature rejected');sessionStorage.setItem('link.signatures',String(Number(sessionStorage.getItem('link.signatures')||0)+1));return '0x'+'11'.repeat(65);}
        if(method==='eth_requestAccounts')sessionStorage.setItem('connect.requests',String(Number(sessionStorage.getItem('connect.requests')||0)+1));
        if(['eth_accounts','eth_requestAccounts'].includes(method))return sessionStorage.getItem('wallet.disconnected')?[]:[owner];
        if(method==='eth_chainId')return'0x279f';
        if(method==='eth_getBlockByNumber')return{number:'0x65',hash};
        if(method==='eth_getCode')return code;
        if(method==='eth_call')return'0x';
        if(method==='eth_estimateGas')return'0x186a0';
        if(method==='eth_gasPrice')return'0x3b9aca00';
        if(method==='eth_getBalance')return'0xde0b6b3a7640000';
        if(method==='eth_getTransactionCount')return 121;
        if(method==='eth_sendTransaction'){
          if(sessionStorage.getItem('wallet.rejectSend')){sessionStorage.removeItem('wallet.rejectSend');throw Object.assign(new Error('Rejected'),{code:4001});}
          const pending=JSON.parse(localStorage.getItem('flurbo.'+namespace+'.pending.v1')||'null');
          if(!pending||pending.hash!==null)throw new Error('Pending intent must be stored first');
          sessionStorage.setItem('pilot.sends',String(Number(sessionStorage.getItem('pilot.sends')||0)+1));
          if(sessionStorage.getItem('wallet.unknownSend'))throw new Error('Provider disconnected');
          return hash;
        }
        throw new Error(method);
      }};
    },{owner,hash,code,namespace});
    await page.route('**/*',async(route:any)=>{
      const url=new URL(route.request().url()),path=url.pathname;
      if(path.endsWith('/history'))historyReads++;
      if(path==='/api/market-directory')return route.fulfill({json:{schema:'flurbo.market-directory.v1',active:namespace,markets:[{namespace,label:'September practice',pool:f.manifest.pool,closesAt:f.manifest.publication.draft.closesAt}]}});
      if(path==='/api/account/wallets')return route.fulfill({json:{account:loginAddress,wallets:linked?[owner]:[]}});
      if(path==='/api/account/portfolio-sources')return route.fulfill({json:{account:loginAddress,wallets:linked?[owner]:[],agentWallets:[]}});
      if(path==='/api/account/wallets/challenge'){assert.equal(route.request().postDataJSON().wallet,owner);return route.fulfill({json:{id:'fixture-proof',message:'Link this MetaMask wallet to your Flurbo account; no transaction.'}});}
      if(path==='/api/account/wallets/verify'){assert.equal(route.request().postDataJSON().id,'fixture-proof');linked=true;return route.fulfill({json:{account:loginAddress,wallets:[owner]}});}
      if(path==='/api/account/access')return route.fulfill({json:{approved:true,testingTools:false}});
      if(path==='/api/auth/session')return route.fulfill({json:{session:login?{address:loginAddress,method:'passkey',expiresAt:Date.now()+3600_000}:null}});
      if(path==='/api/'+namespace+'/markets')return route.fulfill({json:await f.service.markets()});
      if(path==='/api/'+namespace+'/price-history'){
        const end=Math.floor(Date.now()/1000);
        return route.fulfill({json:{pool:f.manifest.pool,sampling:'current',points:[0,300,600].map((offset,i)=>({timestamp:end-600+offset,blockNumber:String(100+i),prices:[0,1,2,3].map(event=>({event,yes:String(400000+i*50000),no:String(620000-i*50000)}))}))}});
      }
      if(path==='/api/'+namespace+'/status'){reads++;return route.fulfill({json:await f.service.status(url.searchParams.get('wallet')||undefined)});}
      if(path==='/api/'+namespace+'/validate-trade')return route.fulfill({json:assessSemantics(f.manifest,route.request().postDataJSON())});
      if(path==='/api/'+namespace+'/prepare'){
        const input=route.request().postDataJSON();
        preparedQuantities.push(input.quantity);preparedClaims.push(input);
        if(input.scope===3&&input.mask==='2')await heldCombinationQuote;
        return route.fulfill({json:await f.service.prepare(input)});
      }
      if(path==='/api/'+namespace+'/claim-analytics'){
        const claim=route.request().postDataJSON(),snapshot=(await f.service.status()).snapshot;
        return route.fulfill({json:{schema:'flurbo.claim-analytics.v1',model:'bounded-lmsr-enumeration-v1',chainId:10143,pool:f.manifest.pool,rulesHash:f.manifest.rulesHash,...claim,snapshot,expiresAt:snapshot.timestamp+60,stateDigest:'ab'.repeat(32),unit:'tenths_of_percentage_point',closed:false,values:{market:480,independent:580,difference:-100}}});
      }
      if(path==='/api/'+namespace+'/positions')return route.fulfill({json:{rows:[{mask:'2',quantity:'0',payoutAtoms:null},{mask:'1',quantity:'5000000',payoutAtoms:null}]}});
      if(path==='/api/'+namespace+'/position')return route.fulfill({json:{quantity:'5000000',payoutAtoms:null}});
      if(path==='/api/'+namespace+'/rpc'){
        const request=route.request().postDataJSON();
        const saved=await page.evaluate((namespace:string)=>JSON.parse(localStorage.getItem('flurbo.'+namespace+'.pending.v1')||'null'),namespace);
        if(request.method==='eth_getTransactionReceipt'){f.options.allowance=1_000_000n;return route.fulfill({json:{result:{transactionHash:hash,blockNumber:'0x64',blockHash:hash,status:'0x1'}}});}
        if(request.method==='eth_getTransactionByHash')return route.fulfill({json:{result:{...saved.review.transaction,hash,chainId:'0x279f',blockNumber:'0x64',blockHash:hash,input:saved.review.transaction.data,nonce:saved.nonce}}});
        return route.fulfill({json:{result:request.method==='eth_chainId'?'0x279f':{hash,number:'0x65'}}});
      }
      if(path.startsWith('/api/'))return route.fulfill({status:503,json:{error:'Unavailable fixture service'}});
      const relative=path.startsWith('/assets/')?path.slice(1):'index.html';
      return route.fulfill({body:await readFile(new URL('../dist/'+relative,import.meta.url)),contentType:relative.endsWith('.js')?'text/javascript':relative.endsWith('.css')?'text/css':relative.endsWith('.woff2')?'font/woff2':'text/html'});
    });
    await page.goto('https://flurbo.singu.online/login');
    await page.waitForURL('**/access');await page.getByRole('link',{name:'Explore markets',exact:true}).click();await page.waitForURL('**/markets');
    await page.getByRole('heading',{name:'Will the new cafe open?',exact:true}).waitFor();
    assert.equal(await page.locator('.market-card').count(),4);
    if(process.env.FLURBO_TEST_SCREENSHOT)await page.screenshot({path:process.env.FLURBO_TEST_SCREENSHOT,fullPage:true});
    await page.getByRole('link',{name:'No: Will the concert sell out?',exact:true}).click();
    assert.equal(new URL(page.url()).pathname,'/markets/'+namespace+'/1');
    assert.equal(await page.locator('.market-card').count(),0);
    await page.getByRole('region',{name:'Settlement timeline'}).waitFor();
    const chart=page.getByRole('region',{name:'Price history',exact:true});
    await chart.getByRole('img').waitFor();
    assert.equal(await chart.locator('circle').count(),6);
    await chart.getByText('View exact observations (3)',{exact:true}).click();
    assert.equal(await chart.getByRole('row').count(),4);
    await chart.getByRole('button',{name:'24 hours',exact:true}).click();
    assert.equal(await chart.getByRole('button',{name:'24 hours',exact:true}).getAttribute('aria-pressed'),'true');
    await chart.getByText('View exact observations (3)',{exact:true}).click();
    await chart.getByRole('button',{name:'All samples',exact:true}).click();
    assert.equal(await page.getByRole('heading',{name:'Trade history',exact:true}).count(),0);
    assert.equal(historyReads,0);
    assert.equal(await page.getByRole('button',{name:/Unlock.*wallet|Unlock signing/i}).count(),0);
    assert.equal(await page.locator('.ticket-wallet').getByText('MetaMask',{exact:true}).count(),1);
    assert.equal(await page.locator('#consumer-wallet').count(),0);
    const connectStyle = await page.getByRole('button',{name:/^(Connect MetaMask|Link selected wallet)$/}).evaluate((el:any)=>({height:el.getBoundingClientRect().height,border:getComputedStyle(el).borderStyle}));
    assert.ok(connectStyle.height>=44);assert.equal(connectStyle.border,'solid');
    await page.evaluate(()=>sessionStorage.setItem('wallet.rejectLink','1'));
    await page.getByRole('button',{name:/^(Connect MetaMask|Link selected wallet)$/}).click();
    await page.getByText('Link signature rejected',{exact:true}).waitFor();
    assert.equal(linked,false);assert.equal(await page.getByRole('button',{name:'Allow payment',exact:true}).count(),0);
    await page.evaluate(()=>sessionStorage.removeItem('wallet.rejectLink'));
    await page.getByRole('button',{name:/^(Connect MetaMask|Link selected wallet)$/}).click();
    await page.getByRole('button',{name:'Switch wallet',exact:true}).waitFor();
    assert.equal(linked,true);assert.equal(await page.evaluate(()=>sessionStorage.getItem('link.signatures')),'1');
    assert.equal(await page.evaluate(()=>sessionStorage.getItem('pilot.sends')),null);

    assert.equal(await page.evaluate((key:string)=>sessionStorage.getItem(key),'flurbo.view-wallet:'+loginAddress),owner);
    assert.equal(await page.evaluate(()=>sessionStorage.getItem('flurbo.trading.market')),namespace);
    await page.getByLabel('Shares',{exact:true}).fill('5');
    await page.getByRole('button',{name:'Allow payment',exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>sessionStorage.getItem('pilot.sends')),null);
    // Rejection clears the unsent intent and never counts as a purchase.
    await page.evaluate(()=>sessionStorage.setItem('wallet.rejectSend','1'));
    await page.getByRole('button',{name:'Allow payment',exact:true}).click();
    await page.waitForFunction((ns:string)=>localStorage.getItem('flurbo.'+ns+'.pending.v1')===null,namespace);
    await page.getByRole('button',{name:'Refresh price',exact:true}).click();
    await page.getByRole('button',{name:'Allow payment',exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>sessionStorage.getItem('pilot.sends')),null);
    // A failed reconnect must not leave the earlier signer/review available.
    await page.evaluate(()=>sessionStorage.setItem('wallet.rejectConnect','1'));
    await page.getByRole('button',{name:'Switch wallet',exact:true}).click();
    await page.getByRole('button',{name:/^(Connect MetaMask|Link selected wallet)$/}).waitFor();
    assert.equal(await page.getByRole('button',{name:'Allow payment',exact:true}).count(),0);
    await page.evaluate(()=>sessionStorage.removeItem('wallet.rejectConnect'));
    await page.getByRole('button',{name:/^(Connect MetaMask|Link selected wallet)$/}).click();
    await page.getByRole('button',{name:'Allow payment',exact:true}).waitFor();
    await page.evaluate(()=>{sessionStorage.setItem('wallet.disconnected','1');(window as any).walletEvent('accountsChanged');});
    await page.getByRole('button',{name:/^(Connect MetaMask|Link selected wallet)$/}).waitFor();
    assert.equal(await page.getByRole('button',{name:'Allow payment',exact:true}).count(),0);
    await page.evaluate(()=>{sessionStorage.removeItem('wallet.disconnected');(window as any).walletEvent('accountsChanged');});
    await page.getByRole('button',{name:'Allow payment',exact:true}).click();
    await page.getByText('Sent to the network. Confirmation is checked automatically.').waitFor();
    assert.equal(await page.evaluate(()=>sessionStorage.getItem('pilot.sends')),'1');
    await page.reload();await page.getByRole('heading',{name:'Waiting for confirmation'}).waitFor();
    assert.equal(await page.getByRole('button',{name:'Buy 5 shares',exact:true}).count(),0);
    // Confirmation is checked automatically, without another app click.
    await page.getByLabel('Shares',{exact:true}).waitFor();
    assert.equal(await page.getByLabel('Shares',{exact:true}).inputValue(),'5');
    assert.equal(await page.getByRole('radiogroup',{name:'Your answer'}).getByRole('radio',{name:'No',exact:true}).getAttribute('aria-checked'),'true');
    assert.equal(await page.evaluate(()=>sessionStorage.getItem('pilot.sends')),'1');
    // Approval is already confirmed and tracking cleared. The draft must still reopen.
    assert.equal(await page.evaluate((ns:string)=>localStorage.getItem('flurbo.'+ns+'.pending.v1'),namespace),null);
    const connectionsBeforeReload=await page.evaluate(()=>sessionStorage.getItem('connect.requests'));
    await page.reload();await page.getByLabel('Shares',{exact:true}).waitFor();
    assert.equal(await page.getByLabel('Shares',{exact:true}).inputValue(),'5');
    assert.equal(await page.getByRole('radiogroup',{name:'Your answer'}).getByRole('radio',{name:'No',exact:true}).getAttribute('aria-checked'),'true');
    await page.getByRole('button',{name:'Buy 5 shares',exact:true}).waitFor();
    // A multi-share review shows the average price against one share of the same claim.
    await page.getByText(/test AUSD, \d+\.\d% above the price of one share/).waitFor();
    assert.equal(await page.evaluate(()=>sessionStorage.getItem('connect.requests')),connectionsBeforeReload);
    assert.equal(await page.evaluate(()=>sessionStorage.getItem('link.signatures')),'1');
    assert.equal(await page.evaluate(()=>sessionStorage.getItem('pilot.sends')),'1');
    await page.getByRole('button',{name:'Buy 5 shares',exact:true}).click();
    await page.getByRole('heading',{name:'Purchase complete',exact:true}).waitFor();
    assert.deepEqual(await page.evaluate(({namespace,pool,owner}:any)=>JSON.parse(localStorage.getItem(`flurbo.claims.v1:10143:${namespace}:${pool}:${owner}`)||'null'),{namespace,pool:f.manifest.pool,owner}),[{scope:2,mask:'1'}]);
    assert.equal(await page.evaluate(()=>sessionStorage.getItem('pilot.sends')),'2');
    await page.getByRole('region',{name:'Trade this market'}).getByText('5 shares',{exact:true}).waitFor();
    assert.equal(await page.evaluate(({ns,login}:any)=>localStorage.getItem('flurbo.checkout.v1:'+ns+':'+login),{ns:namespace,login:loginAddress}),null);
    assert.equal(await page.getByRole('heading',{name:'Will the concert sell out?',exact:true}).count(),1);
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    if(process.env.FLURBO_TEST_SCREENSHOT)await page.screenshot({path:process.env.FLURBO_TEST_SCREENSHOT.replace('.png','-mobile.png'),fullPage:true});
    await page.getByRole('button',{name:'Make another trade',exact:true}).click();
    await page.getByText('Combine with another prediction',{exact:true}).click();
    const reviewPanel=page.getByRole('region',{name:'Transaction review'});
    // The previous single-claim quote has the same Buy label. Hold the new
    // response to verify it cannot remain actionable while the combination loads.
    let releaseCombinationQuote!:()=>void;
    heldCombinationQuote=new Promise<void>(resolve=>{releaseCombinationQuote=resolve;});
    const andRequest=page.waitForRequest((r:any)=>r.url().endsWith('/prepare')&&r.postDataJSON().scope===3&&r.postDataJSON().mask==='2');
    const andQuote=page.waitForResponse((r:any)=>r.url().endsWith('/prepare')&&r.request().postDataJSON().scope===3&&r.request().postDataJSON().mask==='2');
    try{
      await page.getByRole('checkbox',{name:'Will the night market open?',exact:true}).check();
      await andRequest;
      assert.equal(await reviewPanel.count(),0);
      assert.equal(await page.getByRole('button',{name:'Buy 5 shares',exact:true}).count(),0);
      assert.equal(await page.evaluate(()=>sessionStorage.getItem('pilot.sends')),'2');
    }finally{releaseCombinationQuote();heldCombinationQuote=null;}
    await andQuote;
    await reviewPanel.locator('.review-claim').filter({hasText:'night market open'}).waitFor();
    await page.getByRole('button',{name:'Buy 5 shares',exact:true}).waitFor();
    assert.match(await reviewPanel.textContent(),/night market open/);
    assert.match(await reviewPanel.textContent(),/concert sell out/);
    assert.equal(await page.evaluate(()=>sessionStorage.getItem('pilot.sends')),'2');
    var orQuote=page.waitForResponse((r:any)=>r.url().endsWith('/prepare')&&r.request().postDataJSON().mask==='11');
    await page.getByRole('radio',{name:'At least one (OR) One or more answers are correct, including all',exact:true}).check();
    await orQuote;
    await page.getByRole('button',{name:'Buy 5 shares',exact:true}).waitFor();
    assert.equal(preparedClaims.at(-1).mask,'11'); // A Yes OR B No.
    assert.match(await reviewPanel.textContent(),/ OR /);
    await page.getByText('Compare how the market connects these answers',{exact:true}).click();
    await page.getByRole('button',{name:'Compare with independence',exact:true}).click();
    await page.getByText('48.0%',{exact:true}).waitFor();
    await page.getByText('See winning outcomes',{exact:true}).click();
    assert.equal(await page.locator('.combination-table tr.wins').count(),3);
    const exactQuote=page.waitForResponse((r:any)=>r.url().endsWith('/prepare')&&r.request().postDataJSON().mask==='9');
    await page.getByRole('radio',{name:'Exactly one Exactly one answer is correct',exact:true}).check();
    await exactQuote;
    await page.getByRole('button',{name:'Buy 5 shares',exact:true}).waitFor();
    assert.equal(preparedClaims.at(-1).mask,'9');
    assert.equal(await page.getByText('48.0%',{exact:true}).count(),0); // Old analysis removed.
    await page.getByRole('checkbox',{name:'Will it rain on Saturday?',exact:true}).check();
    const thresholdQuote=page.waitForResponse((r:any)=>r.url().endsWith('/prepare')&&r.request().postDataJSON().mask==='178');
    await page.getByRole('radio',{name:'At least two Two or more answers are correct',exact:true}).check();
    await thresholdQuote;
    await page.getByRole('button',{name:'Buy 5 shares',exact:true}).waitFor();
    assert.equal(preparedClaims.at(-1).scope,7);assert.equal(preparedClaims.at(-1).mask,'178');
    assert.equal(await page.getByRole('checkbox',{name:'Will the new cafe open?',exact:true}).isDisabled(),true);
    await page.reload();
    await page.getByRole('button',{name:'Buy 5 shares',exact:true}).waitFor();
    assert.equal(await page.getByRole('radio',{name:'At least two Two or more answers are correct',exact:true}).isChecked(),true);
    assert.equal(preparedClaims.at(-1).mask,'178');
    {
      await page.setViewportSize({width:1440,height:1000});
      await page.locator('.combination-builder').screenshot({path:new URL('../../../target/combination-desktop.png',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1')});
      await page.setViewportSize({width:390,height:844});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      await page.locator('.combination-builder').screenshot({path:new URL('../../../target/combination-mobile.png',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1')});
      await page.setViewportSize({width:1440,height:1000});
    }
    await page.getByRole('checkbox',{name:'Will it rain on Saturday?',exact:true}).uncheck();
    var orQuote=page.waitForResponse((r:any)=>r.url().endsWith('/prepare')&&r.request().postDataJSON().mask==='11');
    await page.getByRole('radio',{name:'At least one (OR) One or more answers are correct, including all',exact:true}).check();
    await orQuote;
    await page.getByRole('button',{name:'Buy 5 shares',exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>sessionStorage.getItem('pilot.sends')),'2');

    // Oversized combinations must explain the on-chain bound, without requesting
    // an impossible quote or retaining the previous actionable review.
    await page.getByLabel('Shares',{exact:true}).fill('12');
    await page.getByText('This market allows up to 10 shares per trade. Enter 10 or fewer to get a price.',{exact:true}).waitFor();
    assert.equal(await reviewPanel.count(),0);
    assert.equal(await page.getByRole('button',{name:'Refresh price',exact:true}).isDisabled(),true);
    await page.clock.fastForward(1000);
    assert.equal(preparedQuantities.includes('12000000'),false);
    await page.getByLabel('Shares',{exact:true}).fill('10');
    await page.getByRole('button',{name:'Buy 10 shares',exact:true}).waitFor();
    assert.ok(preparedQuantities.includes('10000000'));
    await page.getByLabel('Shares',{exact:true}).fill('10.000001');
    await page.getByText('This market allows up to 10 shares per trade. Enter 10 or fewer to get a price.',{exact:true}).waitFor();
    await page.clock.fastForward(1000);
    assert.equal(preparedQuantities.includes('10000001'),false);
    await page.getByLabel('Shares',{exact:true}).fill('5');
    await page.getByRole('button',{name:'Buy 5 shares',exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>sessionStorage.getItem('pilot.sends')),'2');

    // Expiry removes an actionable price without sending or silently renewing it.
    await page.clock.fastForward(301_000);
    await page.getByText('This price has expired. Refresh the price before confirming. No transaction was sent.').waitFor();
    assert.equal(await page.getByRole('button',{name:'Buy 5 shares',exact:true}).count(),0);
    assert.equal(await page.evaluate(()=>sessionStorage.getItem('pilot.sends')),'2');
    await page.clock.setFixedTime(new Date());
    await page.getByRole('button',{name:'Refresh price',exact:true}).click();
    await page.getByRole('button',{name:'Buy 5 shares',exact:true}).waitFor();
    // A missing response may follow a broadcast. Preserve intent across reload;
    // never make another purchase available until the original is reconciled.
    await page.evaluate(()=>sessionStorage.setItem('wallet.unknownSend','1'));
    await page.getByRole('button',{name:'Buy 5 shares',exact:true}).click();
    await page.getByRole('heading',{name:'Waiting for confirmation'}).waitFor();
    const originalClose=f.manifest.publication.draft.closesAt;
    f.manifest.publication.draft.closesAt=Math.floor(Date.now()/1000)-1;
    await page.reload();
    await page.getByRole('heading',{name:'Waiting for confirmation'}).waitFor();
    assert.equal(await page.evaluate(()=>sessionStorage.getItem('pilot.sends')),'3');
    assert.equal(await page.getByRole('button',{name:'Buy 5 shares',exact:true}).count(),0);
    const unresolved=await page.evaluate((ns:string)=>JSON.parse(localStorage.getItem('flurbo.'+ns+'.pending.v1')!),namespace);
    assert.equal(unresolved.hash,null);
    assert.equal(unresolved.review.requested.scope,3);
    f.manifest.publication.draft.closesAt=originalClose;
    await page.goto('https://flurbo.singu.online/markets');
    // Typing under the loading cover is dropped (the page is inert); wait for the directory to be usable.
    await page.locator('.market-card').first().waitFor();
    await page.waitForFunction(()=>{const root=document.querySelector('.app-root') as HTMLElement|null;return !!root&&!root.inert&&!document.querySelector('.contour-loader');});
    await page.getByRole('textbox',{name:'Search markets'}).fill('concert');
    await page.waitForFunction(()=>document.querySelectorAll('.market-card').length===1);
    assert.equal(await page.locator('.market-card').count(),1);
    login=false;const before=reads;await page.goto('https://flurbo.singu.online/markets');await page.waitForURL('**/login');assert.equal(reads,before);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
