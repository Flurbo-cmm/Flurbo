import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile,mkdir} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

test('native application on desktop and mobile: submit, verify, reload, withdraw and operator decision',{skip:!process.env.FLURBO_TEST_PLAYWRIGHT},async()=>{
  const {chromium}=await import(pathToFileURL(process.env.FLURBO_TEST_PLAYWRIGHT!).href);
  const browser=await chromium.launch({headless:true,executablePath:process.env.FLURBO_TEST_BROWSER});
  let application:any=null,operator=false,approved=false;const account='0x'+'ab'.repeat(20),errors:string[]=[];
  try{
    const page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',(e:Error)=>errors.push(e.message));
    await page.route('**/*',async(route:any)=>{
      const p=new URL(route.request().url()).pathname;
      if(p==='/api/auth/session')return route.fulfill({json:{session:{address:account,method:'passkey',expiresAt:Date.now()+3600000}}});
      if(p==='/api/account/access')return route.fulfill({json:{approved:operator||approved,nativeApplications:true,testingTools:operator,applicationUrl:null}});
      if(p==='/api/account/application')return route.fulfill({json:{application}});
      if(p.endsWith('/application/submit')){const input=route.request().postDataJSON();assert.equal(input.account,undefined);application={account,email:input.email,state:'unverified',verified:false,revision:0,createdAt:new Date().toISOString(),notification:'none'};return route.fulfill({json:{application,delivery:'sent'}});}
      if(p.endsWith('/application/verify')){
        if(route.request().postDataJSON().code!=='443322')return route.fulfill({status:400,json:{error:'The code did not match. Check your email and try again.'}});
        application={...application,state:'pending',verified:true,revision:1};return route.fulfill({json:{application}});
      }
      if(p.endsWith('/application/withdraw')){application={...application,state:'withdrawn',email:null};return route.fulfill({json:{application}});}
      if(p.endsWith('/application/admin/list'))return route.fulfill({json:{applications:[{...application,state:approved?'approved':'pending',verified:true,email:'tester@example.com',notification:'none'}]}});
      if(p.endsWith('/application/admin/decide')){assert.equal(route.request().postDataJSON().decision,'approved');approved=true;return route.fulfill({json:{notification:'sent'}});}
      if(p==='/api/account/wallets')return route.fulfill({json:{account,wallets:[]}});
      if(p.startsWith('/api/'))return route.fulfill({status:503,json:{error:'Unused fixture'}});
      const file=p.startsWith('/assets/')?p.slice(1):'index.html';
      return route.fulfill({body:await readFile(new URL('../dist/'+file,import.meta.url)),contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.woff2')?'font/woff2':'text/html'});
    });
    await page.goto('https://flurbo.singu.online/access');
    await page.getByRole('heading',{name:'Request your invitation.'}).waitFor();
    await page.getByLabel('Email address',{exact:true}).fill('tester@example.com');
    assert.equal(await page.getByRole('button',{name:'Request access',exact:true}).isDisabled(),true);
    await page.getByRole('checkbox',{name:/I understand/}).check();
    await mkdir(new URL('../../../target/access-review/',import.meta.url),{recursive:true});
    for(const width of [1440,390]){
      await page.setViewportSize({width,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      await page.screenshot({path:new URL(`../../../target/access-review/form-${width}.png`,import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1'),fullPage:true});
    }
    await page.getByRole('button',{name:'Request access',exact:true}).click();
    await page.getByLabel('Verification code').fill('111111');await page.getByRole('button',{name:'Verify email',exact:true}).click();
    await page.getByRole('alert').filter({hasText:'code did not match'}).waitFor();
    await page.getByLabel('Verification code').fill('443322');await page.getByRole('button',{name:'Verify email',exact:true}).click();
    await page.getByRole('heading',{name:'Your request is received.'}).waitFor();
    await page.reload();await page.getByRole('heading',{name:'Your request is received.'}).waitFor();
    await page.getByText('Withdraw application',{exact:true}).click();await page.getByRole('checkbox',{name:'Remove my contact email'}).check();
    await page.getByRole('button',{name:'Withdraw request'}).click();await page.getByRole('heading',{name:'Request your invitation.'}).waitFor();
    operator=true;await page.reload();await page.getByText('Review access applications',{exact:true}).click();
    await page.getByRole('button',{name:'Load applications'}).click();await page.getByRole('button',{name:'Approve',exact:true}).click();
    assert.equal(approved,false);await page.getByRole('button',{name:'Confirm decision'}).click();await page.getByText('Decision saved.',{exact:true}).waitFor();
    assert.equal(approved,true);assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

test('access checks preserve the form and distinguish unavailable status from closed applications',{skip:!process.env.FLURBO_TEST_PLAYWRIGHT},async()=>{
  const {chromium}=await import(pathToFileURL(process.env.FLURBO_TEST_PLAYWRIGHT!).href);
  const browser=await chromium.launch({headless:true,executablePath:process.env.FLURBO_TEST_BROWSER});
  let account='0x'+'cd'.repeat(20),accessFail=false,statusFail=false,approved=false;
  let accessCalls=0,statusCalls=0;
  let hold:Promise<void>|null=null,release=()=>{};
  let application:any={account,email:'saved@example.com',state:'pending',verified:true,revision:1};
  try{
    const page=await browser.newPage({viewport:{width:1200,height:950}});
    await page.route('**/*',async(route:any)=>{
      const p=new URL(route.request().url()).pathname;
      if(p==='/api/auth/session')return route.fulfill({json:{session:{address:account,method:'passkey',expiresAt:Date.now()+3600000}}});
      if(p==='/api/account/access'){
        accessCalls++;if(hold)await hold;
        return route.fulfill(accessFail?{status:503,json:{error:'Temporary outage'}}:{json:{approved,nativeApplications:true,testingTools:false,applicationUrl:null}});
      }
      if(p==='/api/account/application'){
        statusCalls++;return route.fulfill(statusFail?{status:503,json:{error:'Application service unavailable.'}}:{json:{application}});
      }
      if(p==='/api/account/wallets')return route.fulfill({json:{account,wallets:[]}});
      if(p.startsWith('/api/'))return route.fulfill({status:503,json:{error:'Unused fixture'}});
      const file=p.startsWith('/assets/')?p.slice(1):'index.html';
      return route.fulfill({body:await readFile(new URL('../dist/'+file,import.meta.url)),contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.woff2')?'font/woff2':'text/html'});
    });
    await page.goto('https://flurbo.singu.online/access');
    await page.getByRole('heading',{name:'Your request is received.'}).waitFor();
    assert.equal(accessCalls,1,'only one access request per mount');
    assert.equal(statusCalls,1);
    await page.getByRole('button',{name:'Change email',exact:true}).click();
    await page.getByLabel('Email address',{exact:true}).fill('unfinished@example.com');
    hold=new Promise<void>(r=>{release=r;});accessFail=true;
    await page.getByRole('button',{name:'Check application status',exact:true}).click();
    await page.waitForFunction(()=>Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='Checking…'&&b.disabled));
    assert.equal(await page.getByLabel('Email address',{exact:true}).inputValue(),'unfinished@example.com');
    assert.equal(await page.getByText('Loading your application…',{exact:true}).count(),0);
    assert.equal(await page.getByText('Request access · Coming soon',{exact:true}).count(),0);
    release();hold=null;
    await page.getByRole('alert').filter({hasText:'refresh your access status'}).waitFor();
    assert.equal(await page.getByLabel('Email address',{exact:true}).inputValue(),'unfinished@example.com');
    assert.equal(statusCalls,2,'refresh must not remount and reload the form');
    await page.getByRole('button',{name:'Cancel',exact:true}).click();
    await page.getByRole('heading',{name:'Your request is received.'}).waitFor();
    await page.waitForLoadState('networkidle');assert.equal(accessCalls,2,'no automatic retry loop');
    await mkdir(new URL('../../../target/access-review/',import.meta.url),{recursive:true});
    await page.screenshot({path:new URL('../../../target/access-review/pending-refresh-error.png',import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1'),fullPage:true});
    // A first-load outage is unknown, never closed or a claim that no request was submitted.
    await page.reload();await page.getByRole('alert').filter({hasText:'refresh your access status'}).waitFor();
    assert.equal(await page.getByText(/Applications are not open yet/).count(),0);
    assert.equal(await page.getByText(/no application has been submitted/).count(),0);
    accessFail=false;statusFail=true;
    await page.getByRole('button',{name:'Check access',exact:true}).click();
    await page.getByRole('heading',{name:'Your application couldn’t be loaded.'}).waitFor();
    assert.equal(await page.getByLabel('Email address',{exact:true}).count(),0,'a failed read is not a new application');
    statusFail=false;await page.getByRole('button',{name:'Check application status',exact:true}).click();
    await page.getByRole('heading',{name:'Your request is received.'}).waitFor();
    // Confirmed approvals take effect; an explicit denial removes protected UI.
    approved=true;application={...application,state:'approved'};
    await page.getByRole('button',{name:'Check application status',exact:true}).click();
    await page.getByRole('heading',{name:'You’re ready to explore'}).waitFor();
    approved=false;application={...application,state:'revoked'};
    await page.evaluate(()=>window.dispatchEvent(new Event('flurbo:access-required')));
    await page.getByRole('heading',{name:'Access is no longer active.'}).waitFor();
    assert.equal(await page.getByRole('link',{name:'Explore markets',exact:true}).count(),0);
    // Another restored account must never see the previous account's application.
    account='0x'+'ef'.repeat(20);application=null;
    await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
    await page.getByRole('heading',{name:'Request your invitation.'}).waitFor();
    assert.equal(await page.getByLabel('Email address',{exact:true}).inputValue(),'');
  }finally{release();await browser.close();}
});
