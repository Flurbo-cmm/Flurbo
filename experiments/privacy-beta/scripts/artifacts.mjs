import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const expected={wasm:'4edc07444a1d48d09014c963e315d3351b6e12838d83fcb1962071614b1c94b9',zkey:'d02521afe7133a97421244374d4bc005c1ebd7d7cf7c51e88b7e99fdaf183146'};
for(const [ext,hash] of Object.entries(expected)){
  let bytes;
  try{bytes=await readFile(join(tmpdir(),'snark-artifacts/semaphore/4.13.0/semaphore-8.'+ext));}catch{}
  if(!bytes||createHash('sha256').update(bytes).digest('hex')!==hash){
    const response=await fetch(`https://snark-artifacts.pse.dev/semaphore/4.13.0/semaphore-8.${ext}`,{redirect:'error',signal:AbortSignal.timeout(60000)});
    if(!response.ok)throw Error('Proving artifact unavailable');bytes=Buffer.from(await response.arrayBuffer());
  }
  if(createHash('sha256').update(bytes).digest('hex')!==hash)throw Error('Proving artifact hash mismatch');
  const dir=new URL('../public/',import.meta.url);await mkdir(dir,{recursive:true});await writeFile(new URL('semaphore-8.'+ext,dir),bytes);
}
console.log('Pinned Semaphore 4.13.0 depth-8 artifacts ready.');
