import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cp,mkdir,readFile} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {productionServer} from '../../../apps/web/server/production.mjs';
import {request} from 'node:http';

test('hosted privacy lab proves locally, restores encrypted notes and sends no secret/API requests',{skip:!process.env.FLURBO_TEST_PLAYWRIGHT},async()=>{
  const {chromium}=await import(pathToFileURL(process.env.FLURBO_TEST_PLAYWRIGHT).href);
  const root=new URL('../../../target/privacy-beta/browser/',import.meta.url);
  await mkdir(root,{recursive:true});await cp(new URL('../dist/',import.meta.url),new URL('privacy-lab/',root),{recursive:true});
  const server=productionServer({origin:'https://flurbo.singu.online',rpcUrl:'https://testnet-rpc.monad.xyz'},{read:async()=>null},fileURLToPath(root));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const browser=await chromium.launch({headless:true,executablePath:process.env.FLURBO_TEST_BROWSER});
  const errors=[],outbound=[];
  try{
    const page=await browser.newPage({viewport:{width:390,height:844}});
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',async route=>{
      const url=new URL(route.request().url());
      if(url.hostname!=='flurbo.singu.online'||route.request().method()!=='GET'){outbound.push(url.href);return route.abort();}
      const response=await new Promise((resolve,reject)=>{const req=request({hostname:'127.0.0.1',port:server.address().port,path:url.pathname,headers:{Host:'flurbo.singu.online'}},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));});req.on('error',reject);req.end();});
      delete response.headers['transfer-encoding'];delete response.headers['content-length'];
      await route.fulfill(response);
    });
    await page.goto('https://flurbo.singu.online/privacy-lab/');
    await page.getByRole('button',{name:'Create four demo notes'}).click();
    await page.getByLabel('Backup password').fill('browser test recovery password');
    const downloadPromise=page.waitForEvent('download');await page.getByRole('button',{name:'Download encrypted backup'}).click();
    const download=await downloadPromise,backup=await readFile(await download.path());
    assert.equal(JSON.parse(backup).encrypted.schema,'flurbo.privacy-note-backup.v1');
    await page.reload();await page.getByLabel('Backup password').fill('browser test recovery password');
    await page.getByLabel('Restore an encrypted demo backup').setInputFiles({name:'note.json',mimeType:'application/json',buffer:backup});
    await page.getByText('Note recovered locally. You can generate a new proof.').waitFor();
    await page.getByRole('button',{name:'Generate and verify proof'}).click();
    await page.getByRole('status').filter({hasText:'Proof verified in'}).waitFor({timeout:90000});
    const proof=JSON.parse(await page.locator('#proof').textContent());assert.ok(proof.nullifier);assert.equal('privateKey' in proof,false);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.screenshot({path:fileURLToPath(new URL('mobile.png',root)),fullPage:true});
    assert.deepEqual(errors,[]);assert.deepEqual(outbound,[]);
  }finally{await browser.close();await new Promise(r=>server.close(r));}
});
