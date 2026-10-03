import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {pilotFixture,owner} from './pilot-fixture.ts';
import {setup,alice,origin} from './agent-fixture.ts';

const skip=!process.env.FLURBO_TEST_PLAYWRIGHT;
async function asset(route:any,path:string){
  const relative=path.startsWith('/assets/')?path.slice(1):'index.html';
  return route.fulfill({body:await readFile(new URL('../dist/'+relative,import.meta.url)),contentType:relative.endsWith('.js')?'text/javascript':relative.endsWith('.css')?'text/css':relative.endsWith('.woff2')?'font/woff2':'text/html'});
}
// Waits a bounded time for the rendered result of a keyboard action.
const expanded=(select:any,value:'true'|'false')=>select.and(select.page().locator(`[aria-expanded="${value}"]`)).waitFor({timeout:5000});
async function thesisPage(browser:any,options:any={}){
  const f=pilotFixture(Math.floor(Date.now()/1000),4),context=await browser.newContext({viewport:{width:1440,height:1000},...options}),page=await context.newPage(),errors:string[]=[];
  // Practice collections are addressed by pool; this mode keeps the real-event wording.
  f.manifest.publication.mode='deterministic-source-v1';
  page.on('pageerror',(e:Error)=>errors.push(e.message));
  await page.route('**/*',async(route:any)=>{
    const path=new URL(route.request().url()).pathname;
    if(path==='/api/market-directory')return route.fulfill({json:{schema:'flurbo.market-directory.v1',markets:[{namespace:'practice-2222222222222222222222222222222222222222',label:'Test pool',pool:f.manifest.pool,closesAt:f.manifest.publication.draft.closesAt}]}});
    if(path==='/api/account/access')return route.fulfill({json:{approved:true,testingTools:false}});
    if(path==='/api/auth/session')return route.fulfill({json:{session:{address:owner,method:'passkey',expiresAt:Date.now()+3600_000}}});
    if(path==='/api/practice-2222222222222222222222222222222222222222/status')return route.fulfill({json:await f.service.status()});
    if(path==='/api/practice-2222222222222222222222222222222222222222/markets')return route.fulfill({json:await f.service.markets()});
    if(path.startsWith('/api/'))return route.fulfill({status:503,json:{error:'Offline fixture'}});
    return asset(route,path);
  });
  await page.goto('https://flurbo.singu.online/markets/practice-2222222222222222222222222222222222222222/0/thesis');
  return {page,context,errors};
}

test('select and segmented controls work from the keyboard and fall back to native controls on touch',{skip},async()=>{
  const {chromium}=await import(pathToFileURL(process.env.FLURBO_TEST_PLAYWRIGHT!).href),browser=await chromium.launch({headless:true,executablePath:process.env.FLURBO_TEST_BROWSER});
  try{
    const {page,errors}=await thesisPage(browser);
    const select=page.getByRole('combobox',{name:'Question B',exact:true});
    await select.waitFor();
    await page.locator('.contour-loader').waitFor({state:'detached'});
    assert.equal(await page.locator('.app-root').evaluate((e:HTMLElement)=>e.inert),false,'the page is interactive');
    const before=await select.innerText();
    await select.focus();
    assert.equal(await select.evaluate((e:Element)=>e===document.activeElement),true,'the combobox has focus before any key is sent');
    await page.keyboard.press('ArrowDown');
    await expanded(select,'true');
    const listbox=page.getByRole('listbox');await listbox.waitFor();
    assert.ok(await select.getAttribute('aria-activedescendant'),'the active option is announced while focus stays on the button');
    await page.keyboard.press('Escape');
    await expanded(select,'false');
    assert.equal(await select.innerText(),before,'Escape closes without changing the choice');
    await page.keyboard.press('ArrowDown');await expanded(select,'true');
    await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');
    await expanded(select,'false');
    assert.notEqual(await select.innerText(),before,'arrows and Enter choose another question');
    assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('role')),'combobox','focus returns to the select');

    const group=page.getByRole('radiogroup',{name:"A's selected answer"});
    const yes=group.getByRole('radio',{name:'Yes',exact:true}),no=group.getByRole('radio',{name:'No',exact:true});
    const start=await yes.getAttribute('aria-checked')==='true'?yes:no,other=start===yes?no:yes;
    await start.focus();await page.keyboard.press('ArrowRight');
    await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-checked')==='true'&&document.activeElement?.getAttribute('role')==='radio');
    assert.equal(await other.getAttribute('aria-checked'),'true','arrow keys move the selection');
    assert.equal(await start.getAttribute('aria-checked'),'false');
    assert.equal(await start.getAttribute('tabindex'),'-1','only the checked option is in the tab order');
    await page.keyboard.press('Home');
    await page.waitForFunction(()=>document.activeElement?.textContent==='Yes');
    assert.equal(await yes.getAttribute('aria-checked'),'true');
    assert.deepEqual(errors,[]);

    const touch=await thesisPage(browser,{viewport:{width:390,height:844},isMobile:true,hasTouch:true});
    const coarse=await touch.page.evaluate(()=>matchMedia('(pointer: coarse)').matches);
    assert.equal(coarse,true,'the touch fixture reports a coarse pointer');
    const native=touch.page.getByLabel('Question B',{exact:true});await native.waitFor();
    assert.equal(await native.evaluate((e:Element)=>e.tagName),'SELECT','touch devices get the native select');
    assert.equal(await touch.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    assert.deepEqual(touch.errors,[]);
  }finally{await browser.close();}
});

test('allowing live agent trades asks for confirmation that restates the limits',{skip},async()=>{
  const {chromium}=await import(pathToFileURL(process.env.FLURBO_TEST_PLAYWRIGHT!).href),browser=await chromium.launch({headless:true,executablePath:process.env.FLURBO_TEST_BROWSER});
  const s=setup({at:Math.floor(Date.now()/1000)}),errors:string[]=[],policies:any[]=[];
  try{
    const page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',(e:Error)=>errors.push(e.message));
    await page.route('**/*',async(route:any)=>{
      const p=new URL(route.request().url()).pathname,method=route.request().method();
      if(p==='/api/auth/session')return route.fulfill({json:{session:{address:alice,method:'passkey',expiresAt:Date.now()+3600000}}});
      if(p==='/api/account/access')return route.fulfill({json:{approved:true}});
      if(p==='/api/market-directory')return route.fulfill({json:{schema:'flurbo.market-directory.v1',markets:[{namespace:'pilot',label:'Open fixture',pool:s.f.manifest.pool,closesAt:s.f.manifest.publication.draft.closesAt}]}});
      if(p==='/api/pilot/markets')return route.fulfill({json:await s.f.service.markets()});
      if(p==='/api/agents'||p.startsWith('/api/agents/')){
        const body=method==='POST'?route.request().postDataJSON():undefined;
        if(p.endsWith('/runtime-policy')&&method==='POST')policies.push(body);
        const result=await s.call(alice,method,p,body);return route.fulfill({status:result.status,json:result.body});
      }
      if(p.startsWith('/api/'))return route.fulfill({status:503,json:{error:'Unused fixture'}});
      return asset(route,p);
    });
    await page.goto(origin+'/agents');
    // The page is inert under the loading cover, so typing there is dropped. Wait for the loaded page itself
    // (agent list and market choices rendered, cover gone), not just for the cover to be absent.
    await page.waitForFunction(()=>{const root=document.querySelector('.app-root') as HTMLElement|null;return !!root&&!root.inert&&!document.querySelector('.contour-loader')&&!!document.querySelector('.agents-list')&&!document.querySelector('.agents-rows-skeleton')&&!!document.querySelector('#register-agent input[type=checkbox]');});
    const form=page.getByRole('form',{name:'Register an agent'});
    await form.getByLabel('Name',{exact:true}).fill('Confirmation agent');await form.getByRole('button',{name:'Register agent',exact:true}).click();
    await page.waitForURL(/\/agents\/[0-9a-f-]{36}$/, {timeout:15000}).catch(async()=>{throw Error(await page.locator('main').innerText());});
    await page.getByRole('button',{name:'Settings',exact:true}).click();
    await page.getByLabel('Most per trade, test AUSD (Flurbo limit)').fill('2');await page.getByLabel('Most per 24 hours, test AUSD').fill('5');
    await page.getByRole('button',{name:'Save limits'}).click();
    for(let i=0;i<100&&!policies.length;i++)await page.waitForTimeout(20);
    await page.waitForLoadState('networkidle');
    const allow=page.getByRole('button',{name:'Allow live testnet trades'});
    const before=policies.length;
    await allow.click();
    const confirm=page.getByRole('group',{name:'Confirm live testnet trades'});await confirm.waitFor();
    assert.equal(policies.length,before,'opening the confirmation changes nothing');
    const text=await confirm.innerText();
    assert.match(text,/2 test AUSD per trade/);assert.match(text,/5 test AUSD per 24 hours/);
    assert.equal(await allow.isDisabled(),true);
    await confirm.getByRole('button',{name:'Cancel'}).click();
    assert.equal(await confirm.count(),0);assert.equal(policies.length,before);
    await allow.click();await confirm.getByRole('button',{name:'Confirm live testnet trades'}).click();
    await page.getByRole('button',{name:'Stop allowing live trades'}).waitFor();
    assert.deepEqual(policies.slice(before),[{liveEnabled:true}]);
    await page.getByRole('button',{name:'Stop allowing live trades'}).click();
    await allow.waitFor();
    assert.deepEqual(policies.slice(before),[{liveEnabled:true},{liveEnabled:false}],'stopping live trades needs no confirmation');
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
