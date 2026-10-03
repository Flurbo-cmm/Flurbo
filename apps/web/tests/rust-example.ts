import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const rootUrl=new URL('../../../',import.meta.url),root=fileURLToPath(rootUrl);
const built=new Map<string,string>();

// Builds a flurbo-core debug example once per test process; cargo is a no-op when it is already fresh (as in CI).
export function rustExample(name:string){
  let file=built.get(name);
  if(file)return file;
  try{execFileSync('cargo',['build','--locked','--quiet','-p','flurbo-core','--example',name],{cwd:root,stdio:['ignore','ignore','inherit']});}
  catch(error:any){throw Error(`Building the ${name} Rust example failed; install cargo or run \`cargo build -p flurbo-core --examples\` from the repository root (${error.code??error.status})`);}
  file=fileURLToPath(new URL(`target/debug/examples/${name}${process.platform==='win32'?'.exe':''}`,rootUrl));
  built.set(name,file);
  return file;
}
