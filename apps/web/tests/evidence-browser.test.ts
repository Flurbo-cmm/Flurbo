import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile,mkdir} from 'node:fs/promises';
import {pathToFileURL,fileURLToPath} from 'node:url';

test('evidence review stays read-only, labels unavailable AI and safely renders source text on mobile',{skip:!process.env.FLURBO_TEST_PLAYWRIGHT},async()=>{
  const {chromium}=await import(pathToFileURL(process.env.FLURBO_TEST_PLAYWRIGHT!).href);
  const browser=await chromium.launch({headless:true,executablePath:process.env.FLURBO_TEST_BROWSER});
  const errors:string[]=[],posts:any[]=[];let walletCalls=0;
  const report={schema:'flurbo.evidence-review.v1',question:'Official release question',pool:'0x'+'11'.repeat(20),rulesHash:'0x'+'ab'.repeat(32),generatedAt:1790000000,reportHash:'ab'.repeat(32),
    assessment:{recommendation:'ABSTAIN',reason:'The observation window has not ended.',checks:['Exact repository and tag']},
    evidence:[{id:'official-release',endpoint:'https://api.github.com/repos/ethereum/go-ethereum/releases/tags/v1.17.7',payloadHash:'cd'.repeat(32),status:200,body:'<img src=x onerror="window.injected=true">'}],
    ai:{status:'unavailable',model:'gemini-2.5-flash-lite',explanation:null},humanReviewRequired:true,transactionSubmitted:false,notice:'Human review is required.'};
  try{
    const page=await browser.newPage({viewport:{width:390,height:844}});page.on('pageerror',(e:Error)=>errors.push(e.message));
    await page.exposeFunction('walletTouched',()=>{walletCalls++;});
    await page.addInitScript(()=>{(window as any).ethereum={isMetaMask:true,request:()=>{(window as any).walletTouched();throw Error('No signing allowed');}};});
    await page.route('**/*',async(route:any)=>{
      const path=new URL(route.request().url()).pathname;
      if(path==='/api/account/access')return route.fulfill({json:{approved:true,testingTools:true}});
      if(path==='/api/auth/session')return route.fulfill({json:{session:{address:'0x'+'11'.repeat(20),method:'passkey',expiresAt:Date.now()+3600000}}});
      if(path==='/api/evidence-beta'){
        if(route.request().method()==='GET')return route.fulfill({json:{operator:true,model:'gemini-2.5-flash-lite',aiConfigured:true,events:[{id:'A',question:'Official release question'}]}});
        posts.push(route.request().postDataJSON());return route.fulfill({json:report});
      }
      if(path.startsWith('/api/'))return route.fulfill({status:503,json:{error:'Unexpected API'}});
      const relative=path.startsWith('/assets/')?path.slice(1):'index.html';
      return route.fulfill({body:await readFile(new URL('../dist/'+relative,import.meta.url)),contentType:relative.endsWith('.js')?'text/javascript':relative.endsWith('.css')?'text/css':relative.endsWith('.woff2')?'font/woff2':'text/html'});
    });
    await page.goto('https://flurbo.singu.online/evidence');
    await page.getByLabel('Add an AI explanation').check();
    await page.getByRole('button',{name:'Prepare evidence report'}).click();
    await page.getByRole('heading',{name:'No recommendation: human review needed'}).waitFor();
    await page.getByText('AI assistance was unavailable or failed validation. No model recommendation is shown.').waitFor();
    await page.getByText('Archived source response',{exact:true}).click();
    assert.equal(await page.locator('pre').textContent(),report.evidence[0].body);
    assert.equal(await page.evaluate(()=>(window as any).injected),undefined);
    const download=page.waitForEvent('download');await page.getByRole('button',{name:'Download review and evidence'}).click();
    assert.equal(JSON.parse(await readFile(await (await download).path(),'utf8')).transactionSubmitted,false);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    const output=new URL('../../../target/evidence-beta/',import.meta.url);await mkdir(output,{recursive:true});
    await page.screenshot({path:fileURLToPath(new URL('mobile.png',output)),fullPage:true});
    assert.deepEqual(posts,[{eventId:'A',useAI:true}]);assert.equal(walletCalls,0);assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
