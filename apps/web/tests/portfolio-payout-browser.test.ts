import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile,mkdir} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {decodeFunctionData,encodeFunctionResult} from 'viem';
import {pilotFixture,owner,hash,code,pool} from './pilot-fixture.ts';
import {pilotPoolAbi} from '../shared/pilot.mjs';
import {pilotService} from '../server/pilot.mjs';

test('portfolio alone collects owned payouts, preserves combined totals and recovers pending redemption',{skip:!process.env.FLURBO_TEST_PLAYWRIGHT},async()=>{
  const {chromium}=await import(pathToFileURL(process.env.FLURBO_TEST_PLAYWRIGHT!).href);
  const browser=await chromium.launch({headless:true,executablePath:process.env.FLURBO_TEST_BROWSER});
  const login='0x'+'99'.repeat(20),second='0x'+'ab'.repeat(20),empty='0x'+'cd'.repeat(20),f=pilotFixture(Math.floor(Date.now()/1000),4);
  f.manifest.publication.mode='rehearsal';
  let paid=false,confirm=false;const errors:string[]=[],intents:any[]=[];
  const units=(wallet:string,scope:number,mask:string)=>scope===3&&mask==='8'?(wallet===owner&&!paid?'10000000':wallet===second?'7000000':'0'):'0';
  const rpc=async(method:string,params:any[]=[])=>{
    if(method==='eth_call'&&params[0].to===pool&&!params[0].from){
      const {functionName,args}=decodeFunctionData({abi:pilotPoolAbi,data:params[0].data});
      if(functionName==='holdings')return encodeFunctionResult({abi:pilotPoolAbi,functionName,result:BigInt(units(String(args![0]),Number(args![1]),String(args![2])))});
      if(functionName==='resolved')return encodeFunctionResult({abi:pilotPoolAbi,functionName,result:true});
      if(functionName==='payoutFraction')return encodeFunctionResult({abi:pilotPoolAbi,functionName,result:[1n,1n]});
    }
    return f.rpc(method,params);
  };
  const service=pilotService({manifest:f.manifest,rpc,now:()=>Math.floor(Date.now()/1000)});
  try{
    const page=await browser.newPage({viewport:{width:390,height:844}});page.on('pageerror',(e:Error)=>errors.push(e.message));
    await page.addInitScript(({owner,empty,hash,code}:any)=>{
      (window as any).selectedWallet=empty;
      (window as any).ethereum={isMetaMask:true,request:async({method}:any)=>{
        if(['eth_accounts','eth_requestAccounts'].includes(method))return[(window as any).selectedWallet];
        if(method==='wallet_requestPermissions')return[];
        if(method==='eth_chainId')return'0x279f';
        if(method==='eth_getBlockByNumber')return{hash,number:'0x65'};
        if(method==='eth_getCode')return code;
        if(method==='eth_call')return'0x';
        if(method==='eth_estimateGas')return'0x186a0';
        if(method==='eth_gasPrice')return'0x3b9aca00';
        if(method==='eth_getBalance')return'0xde0b6b3a7640000';
        if(method==='eth_getTransactionCount')return 121;
        if(method==='eth_sendTransaction'){
          if(sessionStorage.getItem('reject')){sessionStorage.removeItem('reject');throw Object.assign(Error('Rejected'),{code:4001});}
          sessionStorage.setItem('sends',String(Number(sessionStorage.getItem('sends')||0)+1));return hash;
        }
        throw Error(method);
      }};
    },{owner,empty,hash,code});
    await page.route('**/*',async(route:any)=>{
      const u=new URL(route.request().url()),p=u.pathname,api='/api/practice-2222222222222222222222222222222222222222/';
      if(p==='/api/auth/session')return route.fulfill({json:{session:{address:login,method:'passkey',expiresAt:Date.now()+3600000}}});
      if(p==='/api/account/access')return route.fulfill({json:{approved:true,testingTools:false}});
      if((p==='/api/account/wallets'||p==='/api/account/portfolio-sources'))return route.fulfill({json:{account:login,wallets:[owner,second,empty]}});
      if(p==='/api/market-directory')return route.fulfill({json:{schema:'flurbo.market-directory.v1',active:'practice-2222222222222222222222222222222222222222',markets:[{namespace:'practice-2222222222222222222222222222222222222222',label:'Settled round',pool,closesAt:f.manifest.publication.draft.closesAt}]}});
      if(p===api+'status'){const s=await service.status(u.searchParams.get('wallet')||undefined);s.cases.forEach((c:any,i:number)=>{c.phase=3;c.result=i===3?3:2;});s.resolved=true;s.delivered=true;return route.fulfill({json:s});}
      if(p===api+'account')return route.fulfill({json:{...await service.account(u.searchParams.get('wallet')),claimScopes:[3]}});
      if(p===api+'history')return route.fulfill({json:{complete:true,logs:[]}});
      if(p===api+'positions'){
        const input=route.request().postDataJSON();return route.fulfill({json:{rows:input.claims.map((c:any)=>({...c,quantity:units(input.owner,c.scope,c.mask),payoutAtoms:units(input.owner,c.scope,c.mask)}))}});
      }
      if(p===api+'position'){const input=route.request().postDataJSON();return route.fulfill({json:await service.position(input.owner,input.scope,input.mask)});}
      if(p===api+'prepare'){const input=route.request().postDataJSON();intents.push(input);return route.fulfill({json:await service.prepare(input)});}
      if(p===api+'rpc'){
        const input=route.request().postDataJSON(),saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('flurbo.practice-2222222222222222222222222222222222222222.pending.v1')||'null'));
        if(input.method==='eth_getTransactionReceipt'){
          if(!confirm)return route.fulfill({json:{result:null}});paid=true;
          return route.fulfill({json:{result:{transactionHash:hash,blockNumber:'0x64',blockHash:hash,status:'0x1'}}});
        }
        if(input.method==='eth_getTransactionByHash')return route.fulfill({json:{result:{...saved.review.transaction,hash,chainId:'0x279f',blockNumber:'0x64',blockHash:hash,input:saved.review.transaction.data,nonce:saved.nonce}}});
        return route.fulfill({json:{result:input.method==='eth_chainId'?'0x279f':{hash,number:'0x65'}}});
      }
      if(p.startsWith('/api/'))return route.fulfill({status:503,json:{error:'Unused fixture API'}});
      const relative=p.startsWith('/assets/')?p.slice(1):'index.html';return route.fulfill({body:await readFile(new URL('../dist/'+relative,import.meta.url)),contentType:relative.endsWith('.js')?'text/javascript':relative.endsWith('.css')?'text/css':'text/html'});
    });
    await page.goto('https://flurbo.singu.online/portfolio');
    await page.getByRole('cell',{name:'17',exact:true}).waitFor();
    await page.getByRole('region',{name:'Your shares'}).getByText('17 test AUSD',{exact:true}).waitFor();
    assert.equal(await page.getByRole('region',{name:'Market results'}).count(),0);
    assert.equal(await page.locator('a[href="/history"]').count(),0);
    await page.getByRole('button',{name:'Collect payout',exact:true}).click();
    const form=page.getByRole('region',{name:'Collect portfolio payout'});
    await form.getByRole('button',{name:'Switch wallet',exact:true}).waitFor();
    await form.getByText('This wallet has no eligible payout for this holding. Switch to its owning MetaMask wallet.').waitFor();
    assert.equal(await form.getByRole('button',{name:'Review payout',exact:true}).isDisabled(),true);assert.equal(intents.length,0);
    await page.evaluate((wallet:string)=>(window as any).selectedWallet=wallet,owner);
    await form.getByRole('button',{name:'Switch wallet',exact:true}).click();
    await form.getByRole('button',{name:'Review payout',exact:true}).click();
    await form.getByText('10 test AUSD',{exact:true}).waitFor();
    assert.equal(intents[0].action,'redeem');assert.equal(intents[0].quantity,'10000000');assert.equal(intents[0].scope,3);assert.equal(intents[0].mask,'8');
    await page.evaluate(()=>sessionStorage.setItem('reject','1'));await form.getByRole('button',{name:'Confirm payout in MetaMask'}).click();
    await form.getByText('Wallet request rejected.',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>localStorage.getItem('flurbo.practice-2222222222222222222222222222222222222222.pending.v1')),null);
    await form.getByRole('button',{name:'Review payout',exact:true}).click();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await mkdir(new URL('../../../target/portfolio-payout/',import.meta.url),{recursive:true});
    await page.screenshot({path:new URL('../../../target/portfolio-payout/mobile.png',import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1'),fullPage:true});
    await form.getByRole('button',{name:'Confirm payout in MetaMask'}).click();await form.getByRole('heading',{name:'Checking your transaction'}).waitFor();
    await page.reload();await page.getByRole('heading',{name:'Checking your transaction'}).waitFor();confirm=true;
    await page.getByText('Payout collected. Your portfolio has been refreshed.').waitFor();
    await page.getByRole('cell',{name:'7',exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>sessionStorage.getItem('sends')),'1');assert.equal(await page.evaluate(()=>localStorage.getItem('flurbo.practice-2222222222222222222222222222222222222222.pending.v1')),null);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
