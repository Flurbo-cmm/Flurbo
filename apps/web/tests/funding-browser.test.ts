import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile,mkdir} from 'node:fs/promises';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {pilotFixture,owner,hash} from './pilot-fixture.ts';
import {TESTNET} from '../server/network.mjs';

test('funding uses announced MetaMask instead of competing injection or Mera; account changes stop submission', {skip:!process.env.FLURBO_TEST_PLAYWRIGHT}, async()=>{
  const {chromium}=await import(pathToFileURL(process.env.FLURBO_TEST_PLAYWRIGHT!).href);
  const browser=await chromium.launch({headless:true,executablePath:process.env.FLURBO_TEST_BROWSER});
  const login='0x'+'99'.repeat(20),f=pilotFixture(Math.floor(Date.now()/1000),4);
  f.manifest.publication.mode='rehearsal';
  try {
    const page=await browser.newPage();
    await page.addInitScript(({owner,hash}:any)=>{
      const callbacks=new Map<string,Set<()=>void>>();
      (window as any).ethereum={isMetaMask:true,isPhantom:true,request:()=>{throw Error('Phantom must never be used');}};
      const metamask={on:(n:string,fn:()=>void)=>{if(!callbacks.has(n))callbacks.set(n,new Set());callbacks.get(n)!.add(fn);},removeListener:(n:string,fn:()=>void)=>callbacks.get(n)?.delete(fn),request:async({method,params}:any)=>{
        if(method==='eth_chainId')return sessionStorage.getItem('chain')||'0x1';
        if(method==='wallet_switchEthereumChain'){sessionStorage.setItem('chain','0x279f');callbacks.get('chainChanged')?.forEach(fn=>fn());return null;}
        if(['eth_accounts','eth_requestAccounts'].includes(method))return [owner];
        if(method==='eth_getBlockByNumber')return {hash,number:'0x64'};
        if(method==='eth_call')return '0x';
        if(method==='eth_gasPrice')return '0x3b9aca00';
        if(method==='eth_estimateGas'){
          if(sessionStorage.getItem('change'))callbacks.get('accountsChanged')?.forEach(fn=>fn());
          return '0x186a0';
        }
        if(method==='eth_sendTransaction'){if(sessionStorage.getItem('reject'))throw {code:4001};sessionStorage.setItem('funding.tx',JSON.stringify(params[0]));return hash;}
        throw Error(method);
      }};
      window.addEventListener('eip6963:requestProvider',()=>window.dispatchEvent(new CustomEvent('eip6963:announceProvider',{detail:{info:{name:'MetaMask',rdns:'io.metamask'},provider:metamask}})));
    },{owner,hash});
    let mon='0xde0b6b3a7640000',stock='0x3b9aca00',receipt:any=null;
    const starterRequests:any[]=[];
    await page.route('**/*',async(route:any)=>{
      const path=new URL(route.request().url()).pathname;
      if(path==='/api/network')return route.fulfill({json:{...TESTNET,flurboFaucet:true,starterMon:'0.3'}});
      if(path==='/api/fund/starter'&&route.request().method()==='GET')return route.fulfill({json:{status:starterRequests.length>=2?'sent':'available',amountMon:'0.3'}});
      if(path==='/api/fund/starter'){starterRequests.push(route.request().postDataJSON());
        if(starterRequests.length===1)return route.fulfill({status:429,json:{code:'DAILY_LIMIT',error:"Today's free test MON has run out. Use the Monad faucet, or try again tomorrow."}});
        return route.fulfill({json:{hash:'0x'+'5'.repeat(64),amountMon:'0.3'}});}
      if(path==='/api/account/access')return route.fulfill({json:{approved:true,testingTools:false}});
      if(path==='/api/account/wallets')return route.fulfill({json:{account:login,wallets:[owner]}});
      if(path==='/api/auth/session')return route.fulfill({json:{session:{address:login,method:'passkey',expiresAt:Date.now()+3600000}}});
      if(path==='/api/market-directory')return route.fulfill({json:{schema:'flurbo.market-directory.v1',active:'practice-2222222222222222222222222222222222222222',markets:[{namespace:'practice-2222222222222222222222222222222222222222',label:'Practice',pool:f.manifest.pool,closesAt:f.manifest.publication.draft.closesAt}]}});
      if(path==='/api/practice-2222222222222222222222222222222222222222/markets')return route.fulfill({json:await f.service.markets()});
      if(path==='/api/rpc'){
        const {method,params}=route.request().postDataJSON();
        let result:any=method==='eth_getBlockByNumber'?{hash,number:'0x64'}:method==='eth_getBalance'?mon:method==='eth_getTransactionReceipt'?receipt:'0x0';
        if(method==='eth_call'&&params[0].data.startsWith('0x70a08231'))result=params[0].data.endsWith(TESTNET.faucet.slice(2))?stock:'0x2faf080';
        return route.fulfill({json:{result}});
      }
      if(path.startsWith('/api/'))return route.fulfill({status:503,json:{error:'Unavailable'}});
      const relative=path.startsWith('/assets/')?path.slice(1):'index.html';
      return route.fulfill({body:await readFile(new URL('../dist/'+relative,import.meta.url)),contentType:relative.endsWith('.js')?'text/javascript':relative.endsWith('.css')?'text/css':'text/html'});
    });
    async function openFunding(){
      await page.goto('https://flurbo.singu.online/fund');
      await page.getByRole('button',{name:'Switch wallet',exact:true}).waitFor();
      if(await page.evaluate(()=>sessionStorage.getItem('chain'))!=='0x279f')await page.getByRole('button',{name:'Switch to Monad testnet',exact:true}).click();
      await page.getByRole('button',{name:'Request test AUSD',exact:true}).waitFor();
    }
    await openFunding();
    assert.equal(await page.evaluate(()=>sessionStorage.getItem('chain')),'0x279f');
    mon='0x0';
    await page.getByRole('button',{name:'Refresh balances'}).click();
    await page.getByText('Get test MON first. Balances update when you return to this page, or use Refresh balances.').waitFor();
    assert.equal(await page.getByRole('button',{name:'Request test AUSD',exact:true}).isDisabled(),true);
    // Flurbo can send one-time starter MON to the linked wallet instead of the external faucet.
    // When today's MON has run out, the button gives way to the reason and the Monad faucet stays offered.
    await page.getByRole('button',{name:'Send me 0.3 test MON',exact:true}).click();
    await page.getByText("Today's free test MON has run out.",{exact:false}).waitFor();
    assert.equal(await page.getByRole('button',{name:'Send me 0.3 test MON',exact:true}).count(),0);
    assert.equal(await page.getByRole('link',{name:/Open MON faucet/}).count(),1);
    await openFunding();
    await page.getByRole('button',{name:'Send me 0.3 test MON',exact:true}).click();
    await page.getByText('Flurbo sent you 0.3 test MON',{exact:false}).waitFor();
    assert.deepEqual(starterRequests,[{wallet:owner},{wallet:owner}]);
    assert.equal(await page.getByRole('button',{name:'Send me 0.3 test MON',exact:true}).count(),0);
    // Test MON arrives from the faucet in another tab. Coming back re-reads balances without a click.
    mon='0xde0b6b3a7640000';
    await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
    await page.getByText('Get test MON first',{exact:false}).waitFor({state:'detached'});
    assert.equal(await page.getByRole('button',{name:'Request test AUSD',exact:true}).isDisabled(),false);
    mon='0xde0b6b3a7640000';stock='0x0';
    await page.getByRole('button',{name:'Refresh balances'}).click();
    await page.getByText('The test AUSD dispenser needs a refill. Please try again later.').waitFor();
    assert.equal(await page.getByRole('button',{name:'Request test AUSD',exact:true}).isDisabled(),true);
    stock='0x3b9aca00';await page.getByRole('button',{name:'Refresh balances'}).click();
    await page.evaluate(()=>sessionStorage.setItem('reject','1'));
    await page.getByRole('button',{name:'Request test AUSD',exact:true}).click();
    await page.getByText('Request cancelled in MetaMask. No funding was confirmed.').waitFor();
    await page.evaluate(()=>sessionStorage.removeItem('reject'));
    await page.evaluate(()=>sessionStorage.setItem('change','1'));
    await page.getByRole('button',{name:'Request test AUSD',exact:true}).click();
    await page.getByText('Wallet changed. Reconnect MetaMask.',{exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>sessionStorage.getItem('funding.tx')),null);
    await page.evaluate(()=>sessionStorage.removeItem('change'));
    await openFunding();
    await page.getByRole('button',{name:'Request test AUSD',exact:true}).click();
    await page.getByRole('link',{name:'View faucet transaction'}).waitFor();
    const tx=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('funding.tx')!));
    assert.equal(tx.from,owner);assert.notEqual(tx.from,login);
    assert.equal(tx.to,TESTNET.faucet);assert.equal(tx.data,TESTNET.faucetSelector+owner.slice(2).padStart(64,'0'));
    assert.equal(await page.getByRole('button',{name:'Request test AUSD',exact:true}).isDisabled(),true);
    await page.reload();
    await page.getByRole('link',{name:'View faucet transaction'}).waitFor();
    assert.equal(await page.getByRole('button',{name:'Request test AUSD',exact:true}).isDisabled(),true);
    await page.getByRole('button',{name:'Switch wallet',exact:true}).waitFor();
    receipt={transactionHash:hash,to:TESTNET.faucet,from:owner,status:'0x1'};
    await page.getByRole('button',{name:'Check status',exact:true}).click();
    await page.getByText('Test AUSD request confirmed. You can return to the markets.').waitFor();
    assert.equal(await page.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith('flurbo.faucet.pending')).length),0);
    await mkdir(new URL('../../../target/showcase-ui/',import.meta.url),{recursive:true});
    await page.screenshot({path:fileURLToPath(new URL('../../../target/showcase-ui/funding-desktop.png',import.meta.url)),fullPage:true});
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.screenshot({path:fileURLToPath(new URL('../../../target/showcase-ui/funding-mobile.png',import.meta.url)),fullPage:true});
    await page.goto('https://flurbo.singu.online/markets');
    await page.locator('.market-card').first().waitFor();
    assert.equal(await page.getByText('Testing tools',{exact:true}).count(),0);
    await page.goto('https://flurbo.singu.online/events');
    await page.getByRole('heading',{name:'Operator access only'}).waitFor();
  } finally {await browser.close();}
});
