import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

const skip=!process.env.FLURBO_TEST_PLAYWRIGHT;
const account='0x'+'ab'.repeat(20);

// Records when the branded loader enters and leaves the page, in page time.
const RECORDER=`window.__loader={added:[],removed:[]};new MutationObserver(()=>{const on=!!document.querySelector('.contour-loader'),log=window.__loader;const last=log.added.length>log.removed.length;if(on&&!last)log.added.push(performance.now());if(!on&&last)log.removed.push(performance.now());}).observe(document,{childList:true,subtree:true});`;

async function open(browser:any,{access,chunk,blockLoader=false,options={}}:{access:(route:any,count:number)=>Promise<void>,chunk?:(route:any,count:number,serve:()=>Promise<void>)=>Promise<void>,blockLoader?:boolean,options?:any}){
  const context=await browser.newContext({viewport:{width:1440,height:900},...options}),page=await context.newPage(),errors:string[]=[];
  page.on('pageerror',(e:Error)=>errors.push(e.message));
  await page.addInitScript(RECORDER);
  let accessCalls=0,chunkCalls=0;
  await page.route('**/*',async(route:any)=>{
    const path=new URL(route.request().url()).pathname;
    if(path==='/api/auth/session')return route.fulfill({json:{session:{address:account,method:'passkey',expiresAt:Date.now()+3600_000}}});
    if(path==='/api/account/access')return access(route,++accessCalls);
    if(path==='/api/agents')return route.fulfill({json:{agents:[],archived:[],durable:true}});
    if(path==='/api/market-directory')return route.fulfill({json:{schema:'flurbo.market-directory.v1',markets:[]}});
    if(path.startsWith('/api/'))return route.fulfill({status:503,json:{error:'Offline fixture'}});
    const relative=path.startsWith('/assets/')?path.slice(1):'index.html';
    if(blockLoader&&/^\/assets\/ContourLoader-[\w-]+\.js$/.test(path))return route.abort();
    if(chunk&&/^\/assets\/Agents-[\w-]+\.js$/.test(path))return chunk(route,++chunkCalls,async()=>route.fulfill({body:await readFile(new URL('../dist/'+relative,import.meta.url)),contentType:'text/javascript'}));
    return route.fulfill({body:await readFile(new URL('../dist/'+relative,import.meta.url)),contentType:relative.endsWith('.js')?'text/javascript':relative.endsWith('.css')?'text/css':relative.endsWith('.woff2')?'font/woff2':'text/html'});
  });
  return {page,context,errors};
}
const approved=(route:any)=>route.fulfill({json:{approved:true}});
const later=(ms:number)=>async(route:any)=>{await new Promise(r=>setTimeout(r,ms));await route.fulfill({json:{approved:true}});};
const heading=(page:any)=>page.getByRole('heading',{name:'Build agents that trade relationships.'});

test('slow Markets revisits show the loader again; a slow agent list never blocks the Agents page',{skip},async()=>{
  const {chromium}=await import(pathToFileURL(process.env.FLURBO_TEST_PLAYWRIGHT!).href),browser=await chromium.launch({headless:true,executablePath:process.env.FLURBO_TEST_BROWSER});
  let release=()=>{};
  try{
    const {page,errors}=await open(browser,{access:approved});
    let heldPath='',pending=Promise.resolve();
    await page.route('**/api/**',async(route:any)=>{
      if(new URL(route.request().url()).pathname===heldPath)await pending;
      await route.fallback();
    });
    for(const [index,path] of ['/markets','/agents','/markets','/agents'].entries()){
      heldPath=path==='/markets'?'/api/market-directory':'/api/agents';
      pending=new Promise<void>(resolve=>{release=resolve;});
      const before=(await page.evaluate(()=>(window as any).__loader?.added.length))??0;
      if(index===0)await page.goto('https://flurbo.singu.online'+path);
      else await page.locator(`a[href="${path}"]`).first().click();
      if(path==='/markets'){
        await page.locator('.contour-loader').waitFor({state:'visible',timeout:5000});
        assert.equal(await page.locator('.app-root').evaluate((e:HTMLElement)=>e.inert),true);
        release();
        await page.locator('.contour-loader').waitFor({state:'detached',timeout:10000});
        assert.equal(await page.locator('.app-root').evaluate((e:HTMLElement)=>e.inert),false);
        const recorded=await page.evaluate(()=>(window as any).__loader);
        assert.equal(recorded.added.length,before+1,'each slow Markets visit shows exactly one loader');
        assert.equal(recorded.removed.length,recorded.added.length,'each loader finishes');
      }else{
        // The agent list has its own skeleton: while it is held, the page is visible and the register form works.
        await heading(page).waitFor({state:'visible',timeout:5000});
        await page.locator('.contour-loader').waitFor({state:'detached',timeout:5000});
        assert.equal(await page.locator('.app-root').evaluate((e:HTMLElement)=>e.inert),false);
        assert.ok(await page.locator('.agents-rows-skeleton').isVisible(),'the list shows its skeleton while loading');
        const name=page.locator('#register-agent input[placeholder="Release relationship agent"]');
        await name.fill('Typed while loading');
        assert.equal(await name.inputValue(),'Typed while loading');
        release();
        await page.locator('.agents-rows-skeleton').waitFor({state:'detached',timeout:10000});
        assert.equal(await name.inputValue(),'Typed while loading','the typed name survives the list arriving');
      }
    }
    assert.deepEqual(errors,[]);
  }finally{release();await browser.close();}
});

test('quick checks complete before the show delay without flashing the loader',{skip},async()=>{
  const {chromium}=await import(pathToFileURL(process.env.FLURBO_TEST_PLAYWRIGHT!).href),browser=await chromium.launch({headless:true,executablePath:process.env.FLURBO_TEST_BROWSER});
  try{
    const {page,errors}=await open(browser,{access:approved});
    // Instant mock responses do not imply a fast page on a busy CI worker.
    // Freeze page time while the real bundle downloads and React mounts, then
    // advance through readiness (60ms) and beyond the show delay (200ms).
    // This also catches a stale show timer that fires after readiness.
    const start=new Date('2026-01-01T00:00:00Z');
    await page.clock.install({time:start});
    await page.clock.pauseAt(start);
    await page.goto('https://flurbo.singu.online/agents');
    await heading(page).waitFor();
    await page.getByText('No agents yet. Register one to start in paper mode.',{exact:true}).waitFor();
    await page.clock.runFor(100);
    await page.clock.runFor(1_000);
    assert.deepEqual(await page.evaluate(()=>(window as any).__loader),{added:[],removed:[]});
    assert.equal(await page.locator('.contour-loader').count(),0);
    assert.equal(await page.locator('.app-root').evaluate((e:HTMLElement)=>e.inert),false);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

test('a check that finishes just before the show delay never covers the ready page',{skip},async()=>{
  const {chromium}=await import(pathToFileURL(process.env.FLURBO_TEST_PLAYWRIGHT!).href),browser=await chromium.launch({headless:true,executablePath:process.env.FLURBO_TEST_BROWSER});
  try{
    // Hold the access check while page time is frozen, then answer it 170ms into the
    // 200ms show delay: readiness is still in its 60ms hold when the show timer fires.
    let release!:()=>void;const held=new Promise<void>(r=>{release=r;});
    const {page,errors}=await open(browser,{access:async(route:any)=>{await held;await route.fulfill({json:{approved:true}});}});
    const start=new Date('2026-01-01T00:00:00Z');
    await page.clock.install({time:start});
    await page.clock.pauseAt(start);
    await page.goto('https://flurbo.singu.online/agents');
    await page.waitForFunction(()=>document.querySelector('.app-root')!==null);
    await page.clock.runFor(170);
    release();
    await heading(page).waitFor();
    await page.getByText('No agents yet. Register one to start in paper mode.',{exact:true}).waitFor();
    await page.clock.runFor(10);
    await page.clock.runFor(40);
    await page.clock.runFor(1_000);
    assert.deepEqual(await page.evaluate(()=>(window as any).__loader),{added:[],removed:[]});
    assert.equal(await page.locator('.app-root').evaluate((e:HTMLElement)=>e.inert),false);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

test('a slow check shows the loader for its minimum time, then reveals the page and restores focus',{skip},async()=>{
  const {chromium}=await import(pathToFileURL(process.env.FLURBO_TEST_PLAYWRIGHT!).href),browser=await chromium.launch({headless:true,executablePath:process.env.FLURBO_TEST_BROWSER});
  try{
    const {page,errors}=await open(browser,{access:later(900)});
    await page.goto('https://flurbo.singu.online/agents');
    const loader=page.locator('.contour-loader');await loader.waitFor();
    assert.equal(await loader.getAttribute('role'),'status','the loader announces what it is waiting for');
    assert.ok((await loader.innerText()).length>0);
    assert.equal(await page.locator('.app-root').evaluate((e:HTMLElement)=>e.inert),true,'the page under the loader cannot be reached');
    await loader.waitFor({state:'detached',timeout:10000});
    await heading(page).waitFor();
    const [added,removed]=await page.evaluate(()=>[(window as any).__loader.added,(window as any).__loader.removed]);
    assert.equal(added.length,1);assert.equal(removed.length,1);
    assert.ok(removed[0]-added[0]>=400,`visible for ${Math.round(removed[0]-added[0])}ms`);
    assert.equal(await page.locator('.app-root').evaluate((e:HTMLElement)=>e.inert),false);
    assert.equal(await page.evaluate(()=>document.activeElement?.id),'main','focus moves to the revealed page');
    assert.equal(await page.evaluate(()=>document.documentElement.style.overflow||getComputedStyle(document.body).overflow),'visible','scrolling is restored');
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

test('the maximum wait shows a recoverable failure instead of an endless loader',{skip},async()=>{
  const {chromium}=await import(pathToFileURL(process.env.FLURBO_TEST_PLAYWRIGHT!).href),browser=await chromium.launch({headless:true,executablePath:process.env.FLURBO_TEST_BROWSER});
  let release=()=>{};
  try{
    // A page download has no timeout of its own, so only the loader's maximum wait can end this one.
    const {page,errors}=await open(browser,{access:approved,chunk:async(route:any,count:number,serve:()=>Promise<void>)=>{if(count===1){await new Promise<void>(r=>{release=r;});return route.abort().catch(()=>undefined);}return serve();}});
    await page.clock.install();
    await page.goto('https://flurbo.singu.online/agents');
    await page.locator('.contour-loader').waitFor();
    // Step the clock so React renders between timers, as it would in real time.
    for(let t=0;t<26;t++)await page.clock.runFor(1_000);
    const failure=page.getByRole('alert').filter({hasText:'We could not finish loading'});await failure.waitFor();
    assert.equal(await page.evaluate(()=>document.activeElement?.textContent),'Try again','the recovery action receives focus');
    await page.getByRole('button',{name:'Try again'}).click();
    await page.clock.runFor(3_000);
    await heading(page).waitFor();
    assert.equal(await page.locator('.contour-loader').count(),0);
    release();
    assert.deepEqual(errors,[]);
  }finally{release();await browser.close();}
});

test('reduced motion shows a static lockup with plain progress',{skip},async()=>{
  const {chromium}=await import(pathToFileURL(process.env.FLURBO_TEST_PLAYWRIGHT!).href),browser=await chromium.launch({headless:true,executablePath:process.env.FLURBO_TEST_BROWSER});
  try{
    const {page,errors}=await open(browser,{access:later(900),options:{reducedMotion:'reduce'}});
    await page.goto('https://flurbo.singu.online/agents');
    const loader=page.locator('.contour-loader');await loader.waitFor();
    await loader.locator('.contour-progress').waitFor();
    await loader.waitFor({state:'detached',timeout:10000});
    await heading(page).waitFor();
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

test('if the animated loader cannot download, a static cover still covers the wait and reveals the page',{skip},async()=>{
  const {chromium}=await import(pathToFileURL(process.env.FLURBO_TEST_PLAYWRIGHT!).href),browser=await chromium.launch({headless:true,executablePath:process.env.FLURBO_TEST_BROWSER});
  try{
    const {page,errors}=await open(browser,{access:later(900),blockLoader:true});
    await page.goto('https://flurbo.singu.online/agents');
    const loader=page.locator('.contour-loader');await loader.waitFor();
    assert.equal(await loader.getAttribute('role'),'status');
    await loader.waitFor({state:'detached',timeout:10000});
    await heading(page).waitFor();
    assert.equal(await page.locator('.app-root').evaluate((e:HTMLElement)=>e.inert),false);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
