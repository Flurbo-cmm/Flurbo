import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile,mkdir} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {setup,alice,origin} from './agent-fixture.ts';

async function asset(route:any,path:string){
  const file=path.startsWith('/assets/')?path.slice(1):'index.html';
  return route.fulfill({body:await readFile(new URL('../dist/'+file,import.meta.url)),contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.woff2')?'font/woff2':'text/html'});
}

test('runtime setup keeps issued credentials across sections and exposes all SDKs and policy controls',{skip:!process.env.FLURBO_TEST_PLAYWRIGHT},async()=>{
  const {chromium}=await import(pathToFileURL(process.env.FLURBO_TEST_PLAYWRIGHT!).href),browser=await chromium.launch({headless:true,executablePath:process.env.FLURBO_TEST_BROWSER});
  const s=setup({at:Math.floor(Date.now()/1000)}),errors:string[]=[];
  try{
    const page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',(e:Error)=>errors.push(e.message));
    await page.route('**/*',async(route:any)=>{
      const p=new URL(route.request().url()).pathname,method=route.request().method();
      if(p==='/api/auth/session')return route.fulfill({json:{session:{address:alice,method:'passkey',expiresAt:Date.now()+3600000}}});
      if(p==='/api/account/access')return route.fulfill({json:{approved:true}});
      if(p==='/api/market-directory')return route.fulfill({json:{schema:'flurbo.market-directory.v1',markets:[{namespace:s.f.namespace,label:'Open fixture',pool:s.f.manifest.pool,closesAt:s.f.manifest.publication.draft.closesAt}]}});
      if(p===`/api/${s.f.namespace}/markets`)return route.fulfill({json:await s.f.service.markets()});
      if(p==='/api/agents'||p.startsWith('/api/agents/')){const result=await s.call(alice,method,p,method==='POST'?route.request().postDataJSON():undefined);return route.fulfill({status:result.status,json:result.body});}
      if(p.startsWith('/api/'))return route.fulfill({status:503,json:{error:'Unused fixture'}});
      return asset(route,p);
    });
    await page.goto(origin+'/agents');
    // The page is inert under the loading cover, so typing there is dropped. Wait for the loaded page itself
    // (agent list and market choices rendered, cover gone), not just for the cover to be absent.
    await page.waitForFunction(()=>{const root=document.querySelector('.app-root') as HTMLElement|null;return !!root&&!root.inert&&!document.querySelector('.contour-loader')&&!!document.querySelector('.agents-list')&&!document.querySelector('.agents-rows-skeleton')&&!!document.querySelector('#register-agent input[type=checkbox]');});
    const form=page.getByRole('form',{name:'Register an agent'});
    await form.getByLabel('Name',{exact:true}).fill('UX fixture agent');await form.getByRole('button',{name:'Register agent',exact:true}).click();
    await page.waitForURL(/\/agents\/[0-9a-f-]{36}$/, {timeout:15000}).catch(async()=>{throw Error(await page.locator('main').innerText());});
    await page.getByRole('button',{name:'Continue setup'}).click();
    const credentials=page.getByRole('region',{name:'API credentials'});
    await credentials.getByRole('button',{name:'Issue credential'}).click();
    await credentials.getByText('Copy this token now. It is shown once.').waitFor();
    const token=await credentials.locator('pre').innerText();assert.ok(token.length>20);
    await page.getByRole('button',{name:'Overview',exact:true}).click();assert.equal(await credentials.isVisible(),false);
    await page.getByRole('button',{name:'Setup',exact:true}).click();assert.equal(await credentials.locator('pre').innerText(),token);
    const run=page.getByRole('region',{name:'Run the agent'});
    for(const language of ['TypeScript','Python','Rust','C++']){await run.getByRole('tab',{name:language,exact:true}).click();assert.match(await run.locator('pre').innerText(),/mode.*paper/);assert.equal(await run.getByRole('button',{name:'Copy commands'}).isEnabled(),true);}
    await page.getByRole('button',{name:'Settings',exact:true}).click();
    await page.getByRole('button',{name:'Pause new actions'}).click();await page.getByRole('button',{name:'Resume new actions'}).waitFor();
    assert.equal(await page.getByRole('button',{name:'Allow live testnet trades'}).isVisible(),true);
    await page.getByRole('button',{name:'Activity',exact:true}).click();await page.getByText('No decisions yet. Start the agent in paper mode from Setup.').waitFor();
    await page.getByRole('button',{name:'Setup',exact:true}).click();await credentials.getByRole('button',{name:'I have stored it'}).click();
    await mkdir(new URL('../../../target/ux-review/',import.meta.url),{recursive:true});
    for(const width of [1440,390]){await page.setViewportSize({width,height:950});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:new URL(`../../../target/ux-review/agent-${width}.png`,import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1'),fullPage:true});}
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
