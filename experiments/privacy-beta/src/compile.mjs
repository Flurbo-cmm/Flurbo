import solc from 'solc';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
export function compile() {
  const input={language:'Solidity',sources:Object.fromEntries(['NoteVault.sol','TestAsset.sol'].map(name=>[name,{content:readFileSync(resolve(root,'contracts',name),'utf8')}])) ,
    settings:{optimizer:{enabled:true,runs:200},evmVersion:'cancun',outputSelection:{'*':{'*':['abi','evm.bytecode']}}}};
  input.sources['Semaphore.sol']={content:'pragma solidity 0.8.28; import "@semaphore-protocol/contracts/Semaphore.sol"; import "@semaphore-protocol/contracts/base/SemaphoreVerifier.sol";'};
  const result=JSON.parse(solc.compile(JSON.stringify(input),{import:path=>{
    try{return {contents:readFileSync(resolve(root,'node_modules',path),'utf8')};}catch{return {error:'Unresolved import: '+path};}
  }}));
  const errors=result.errors?.filter(e=>e.severity==='error');if(errors?.length)throw Error(errors.map(e=>e.formattedMessage).join('\n'));
  return result.contracts;
}
export function artifact(contracts,name) {
  for(const [file,items] of Object.entries(contracts))if(items[name])return {file,...items[name]};
  throw Error('Missing artifact '+name);
}
