import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile,mkdir} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {challengeFixture} from './challenge.test.ts';
import {owner,hash,code} from './pilot-fixture.ts';

test('ordinary account challenges from the market page with separate approval, rejection handling and reload recovery',{skip:!process.env.FLURBO_TEST_PLAYWRIGHT},async()=>{
  const {chromium}=await import(pathToFileURL(process.env.FLURBO_TEST_PLAYWRIGHT!).href);
  const browser=await chromium.launch({headless:true,executablePath:process.env.FLURBO_TEST_BROWSER});
  const f=challengeFixture(),namespace='practice-'+f.manifest.pool.slice(2),login='0x'+'99'.repeat(20),errors:string[]=[];
  // An assertion can only exist after trading and observation have closed.
  f.manifest.publication.draft.closesAt=f.now-7200;
  let confirmDispute=false,eligible=false;
  try{
    const page=await browser.newPage({viewport:{width:1440,height:1000}});
    page.on('pageerror',(e:Error)=>errors.push(e.message));
    await page.addInitScript(({owner,hash,code,namespace}:any)=>{
      (window as any).ethereum={isMetaMask:true,request:async({method}:any)=>{
        if(['eth_accounts','eth_requestAccounts'].includes(method))return[owner];
        if(method==='eth_chainId')return'0x279f';
        if(method==='eth_getBlockByNumber')return{number:'0x65',hash};
        if(method==='eth_getCode')return code;
        if(method==='eth_call')return'0x';
        if(method==='eth_estimateGas')return'0x186a0';
        if(method==='eth_gasPrice')return'0x3b9aca00';
        if(method==='eth_getBalance')return'0xde0b6b3a7640000';
        if(method==='eth_getTransactionCount')return 121;
        if(method==='eth_sendTransaction'){
          if(sessionStorage.getItem('reject')){sessionStorage.removeItem('reject');throw Object.assign(Error('Rejected'),{code:4001});}
          const pending=JSON.parse(localStorage.getItem('flurbo.'+namespace+'.pending.v1')||'null');
          if(!pending||pending.hash!==null)throw Error('Missing saved intent');
          sessionStorage.setItem('sends',String(Number(sessionStorage.getItem('sends')||0)+1));return hash;
        }
        throw Error(method);
      }};
    },{owner,hash,code,namespace});
    await page.route('**/*',async(route:any)=>{
      const url=new URL(route.request().url()),path=url.pathname,api='/api/'+namespace+'/';
      if(path==='/api/auth/session')return route.fulfill({json:{session:{address:login,method:'passkey',expiresAt:Date.now()+3600000}}});
      if(path==='/api/account/access')return route.fulfill({json:{approved:true,testingTools:false}});
      if(path==='/api/market-directory')return route.fulfill({json:{schema:'flurbo.market-directory.v1',active:namespace,markets:[{namespace,label:'Challenge fixture',pool:f.manifest.pool,closesAt:f.manifest.publication.draft.closesAt}]}});
      if(path==='/api/account/wallets')return route.fulfill({json:{account:login,wallets:[owner]}});
      if(path==='/api/account/portfolio-sources')return route.fulfill({json:{account:login,wallets:[owner],agentWallets:[]}});
      if(path===api+'status')return route.fulfill({json:await f.service.status(url.searchParams.get('wallet')||undefined)});
      if(path===api+'markets')return route.fulfill({json:await f.service.markets()});
      if(path===api+'positions')return route.fulfill({json:{rows:[{mask:'1',quantity:'0',payoutAtoms:null},{mask:'2',quantity:'0',payoutAtoms:null}]}});
      if(path===api+'prepare'){
        const input=route.request().postDataJSON();assert.equal(input.action,'dispute');
        const {stake,...action}=input;assert.equal(stake.holder,owner);
        return route.fulfill({json:await f.service.prepare(action)});
      }
      if(path===api+'challenge-eligibility')return route.fulfill({json:{eligible,stake:eligible?{holder:owner,scope:1,mask:'2',wrapped:false}:null,nextCursor:null}});
      if(path===api+'evidence'){
        const input=route.request().postDataJSON();assert.equal(input.eventId,'event-0');assert.equal(input.outcome,1);
        return route.fulfill({json:{hash,uri:'https://flurbo.singu.online/api/pilot/evidence/'+hash}});
      }
      if(path===api+'rpc'){
        const input=route.request().postDataJSON(),saved=await page.evaluate((namespace:string)=>JSON.parse(localStorage.getItem('flurbo.'+namespace+'.pending.v1')||'null'),namespace);
        if(input.method==='eth_getTransactionReceipt'){
          if(saved.review.action==='dispute'&&!confirmDispute)return route.fulfill({json:{result:null}});
          if(saved.review.action==='approve')f.options.allowance=1000000n;
          else {f.c.phase=2;f.c.counter=1;f.c.disputer=owner;f.c.counterEvidenceHash=hash;f.c.voteUntil=BigInt(f.now+3600);}
          return route.fulfill({json:{result:{transactionHash:hash,blockNumber:'0x64',blockHash:hash,status:'0x1'}}});
        }
        if(input.method==='eth_getTransactionByHash')return route.fulfill({json:{result:{...saved.review.transaction,hash,chainId:'0x279f',blockNumber:'0x64',blockHash:hash,input:saved.review.transaction.data,nonce:saved.nonce}}});
        return route.fulfill({json:{result:input.method==='eth_chainId'?'0x279f':{hash,number:'0x65'}}});
      }
      if(path.startsWith('/api/'))return route.fulfill({status:503,json:{error:'Fixture unavailable'}});
      const relative=path.startsWith('/assets/')?path.slice(1):'index.html';
      return route.fulfill({body:await readFile(new URL('../dist/'+relative,import.meta.url)),contentType:relative.endsWith('.js')?'text/javascript':relative.endsWith('.css')?'text/css':relative.endsWith('.woff2')?'font/woff2':'text/html'});
    });
    await page.goto('https://flurbo.singu.online/markets/'+namespace+'/0');
    await page.getByText('Read proposed answer evidence',{exact:true}).click();
    const evidence=page.getByRole('link',{name:'View raw evidence record',exact:false});await evidence.waitFor();assert.equal(await evidence.getAttribute('href'),'/api/'+namespace+'/evidence/'+hash);
    await page.getByRole('button',{name:'Challenge proposed answer',exact:true}).click();
    const form=page.getByRole('region',{name:'Challenge an answer'});
    await form.getByRole('button',{name:'Switch wallet',exact:true}).waitFor();
    await form.getByLabel('Correct answer').selectOption('1');
    await form.getByLabel('Why is the proposed answer wrong?').fill('The published evidence meets the NO rule for this test event.');
    await form.getByLabel('Supporting source URL').fill('https://ethereum.org/');
    assert.equal(await form.getByRole('button',{name:'Save public evidence',exact:true}).count(),0);
    await form.getByRole('button',{name:'Review challenge',exact:true}).click();
    await form.getByText('Your account has no qualifying shares in this event. You cannot challenge this answer.').waitFor();
    assert.equal(await form.getByRole('link',{name:'Read your saved evidence',exact:true}).count(),0);
    assert.equal(await page.evaluate(()=>sessionStorage.getItem('sends')),null);
    eligible=true;
    await form.getByRole('button',{name:'Review challenge',exact:true}).click();
    await form.getByRole('heading',{name:'Approve the challenge bond',exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>sessionStorage.getItem('sends')),null);
    await page.evaluate(()=>sessionStorage.setItem('reject','1'));
    await form.getByRole('button',{name:'Approve bond in MetaMask'}).click();
    await form.getByText('Wallet request rejected.',{exact:true}).waitFor();
    assert.equal(await page.evaluate((key:string)=>localStorage.getItem(key),'flurbo.'+namespace+'.pending.v1'),null);
    await form.getByRole('button',{name:'Review challenge',exact:true}).click();
    await form.getByRole('button',{name:'Approve bond in MetaMask'}).click();
    await form.getByRole('heading',{name:'Confirm your challenge',exact:true}).waitFor();
    await form.getByText('Your answer: NO. Bond: 1 test AUSD.',{exact:true}).waitFor();
    assert.equal(await form.getByLabel('Why is the proposed answer wrong?').count(),0);
    assert.equal(await page.evaluate(()=>sessionStorage.getItem('sends')),'1');
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await mkdir(new URL('../../../target/challenge-ui/',import.meta.url),{recursive:true});
    await page.screenshot({path:new URL('../../../target/challenge-ui/mobile.png',import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1'),fullPage:true});
    await form.getByRole('button',{name:'Submit challenge in MetaMask'}).click();
    await form.getByRole('heading',{name:'Checking your transaction'}).waitFor();
    assert.equal(await page.evaluate(()=>sessionStorage.getItem('sends')),'2');
    await page.reload();
    await page.getByRole('heading',{name:'Checking your transaction'}).waitFor();
    confirmDispute=true;
    await page.getByText('Transaction confirmed. The latest result is shown above.').waitFor();
    assert.equal(await page.evaluate(()=>sessionStorage.getItem('sends')),'2');
    await page.getByText('This answer has been challenged. The testnet reviewer panel decides the dispute.',{exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'Review challenge',exact:true}).count(),0);
    // A submitted challenge belongs to the account on reload, without connecting a wallet again.
    await page.goto('https://flurbo.singu.online/markets/'+namespace+'/0');
    await page.getByRole('button',{name:'View your challenge',exact:true}).click();
    await page.getByRole('region',{name:'Your submitted challenge'}).waitFor();
    assert.equal(await page.getByRole('button',{name:'Review challenge',exact:true}).count(),0);
    f.c.phase=3;f.c.result=1;
    await page.reload();
    await page.getByRole('heading',{name:'Challenge resolved',exact:true}).waitFor();
    await page.getByText('Final answer: NO',{exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'Submit challenge in MetaMask',exact:true}).count(),0);
    // Expiry while a review is open removes the submit action immediately, without a server refresh.
    f.c.phase=1;f.c.disputer='0x'+'00'.repeat(20);f.c.counterEvidenceHash='0x'+'00'.repeat(32);f.c.challengeUntil=BigInt(f.now+3600);
    await page.goto('https://flurbo.singu.online/markets/'+namespace+'/0?challenge=1');
    await form.getByRole('button',{name:'Switch wallet',exact:true}).waitFor();
    await form.getByLabel('Correct answer').selectOption('1');
    await form.getByLabel('Why is the proposed answer wrong?').fill('The published evidence meets the NO rule for this test event.');
    await form.getByLabel('Supporting source URL').fill('https://ethereum.org/');
    await form.getByRole('button',{name:'Review challenge',exact:true}).click();
    await form.getByRole('button',{name:'Submit challenge in MetaMask',exact:true}).waitFor();
    await page.evaluate((time:number)=>{Date.now=()=>time;},Number(f.c.challengeUntil)*1000);
    await form.getByText('The challenge period has ended.',{exact:true}).waitFor();
    assert.equal(await form.getByRole('button',{name:'Submit challenge in MetaMask',exact:true}).count(),0);
    assert.equal(await form.getByRole('button',{name:'Review challenge',exact:true}).count(),0);
    assert.equal(await page.evaluate(()=>sessionStorage.getItem('sends')),'2');
    f.c.challengeUntil=BigInt(f.now-1);
    await page.goto('https://flurbo.singu.online/markets/'+namespace+'/0');
    await page.getByText('The challenge period has ended.',{exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'Challenge proposed answer',exact:true}).count(),0);
    f.c.phase=3;
    await page.reload();
    await page.getByText('The result is final. Challenges are closed.',{exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'View your challenge',exact:true}).count(),0);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
