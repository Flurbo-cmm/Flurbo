import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {pathToFileURL,fileURLToPath} from 'node:url';

test('public docs load directly, navigate by section and fit desktop and mobile without market access', {skip:!process.env.FLURBO_TEST_PLAYWRIGHT},async()=>{
  const {chromium}=await import(pathToFileURL(process.env.FLURBO_TEST_PLAYWRIGHT!).href);
  const browser=await chromium.launch({headless:true,executablePath:process.env.FLURBO_TEST_BROWSER});
  const unexpected:string[]=[];
  try{
    const page=await browser.newPage();
    await page.route('**/*',async(route:any)=>{
      const path=new URL(route.request().url()).pathname;
      if(path==='/api/account/access')return route.fulfill({json:{approved:true,testingTools:false}});
      if(path==='/api/auth/session')return route.fulfill({json:{session:null}});
      if(path.startsWith('/api/')||path==='/healthz'){unexpected.push(path);return route.fulfill({status:503,json:{error:'Unexpected request'}});}
      const file=path.startsWith('/assets/')?path.slice(1):'index.html';
      return route.fulfill({body:await readFile(new URL('../dist/'+file,import.meta.url)),contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.woff2')?'font/woff2':'text/html'});
    });
    await mkdir(new URL('../../../target/docs-ui/',import.meta.url),{recursive:true});
    for(const width of [1440,390,320]){
      await page.setViewportSize({width,height:950});
      await page.goto('https://flurbo.singu.online/docs');
      await page.getByRole('heading',{level:1,name:'Understand the market.'}).waitFor();
      assert.equal(await page.title(),'Documentation | flurbo');
      assert.equal(new URL(page.url()).pathname,'/docs');
      assert.ok(!(await page.locator('main').innerText()).includes('\u2014'));
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      await page.screenshot({path:fileURLToPath(new URL(`../../../target/docs-ui/docs-${width}.png`,import.meta.url)),fullPage:false});
      const contents=page.getByRole('navigation',{name:'Documentation contents'});
      await contents.getByRole('link',{name:'Settlement and payouts'}).click();
      await page.waitForFunction(()=>location.hash==='#settlement'&&Math.abs(document.querySelector('#settlement')!.getBoundingClientRect().top-110)<5);
      await page.reload();
      await page.getByRole('heading',{level:2,name:'Settlement and payouts'}).waitFor();
      assert.equal(new URL(page.url()).hash,'#settlement');
      if(width<680){
        await page.getByRole('button',{name:'Open navigation'}).click();
        await page.getByRole('navigation',{name:'Main navigation'}).getByRole('link',{name:'Docs',exact:true}).click();
        assert.equal(await page.getByRole('button',{name:'Open navigation'}).getAttribute('aria-expanded'),'false');
      }
    }
    assert.deepEqual(unexpected,[]);
  }finally{await browser.close();}
});
