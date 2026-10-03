import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import './artifacts.mjs';
import assert from 'node:assert/strict';
import {createPublicClient,createWalletClient,http,parseAbi,keccak256} from 'viem';
import {foundry} from 'viem/chains';
import {Group} from '@semaphore-protocol/group';
import {compile,artifact} from '../src/compile.mjs';
import {newNote,proveWithdrawal,encryptNote,decryptNote} from '../src/notes.mjs';

// Disposable LOCAL chain only. No environment RPC, real keystore or user key.
const port=18559,url=`http://127.0.0.1:${port}`;
await new Promise((ok,no)=>{const probe=createServer();probe.once('error',no);probe.listen(port,'127.0.0.1',()=>probe.close(ok));});
const executable=process.platform==='win32'?resolve(homedir(),'.foundry/bin/anvil.exe'):'anvil';
const child=spawn(executable,['--host','127.0.0.1','--port',String(port),'--chain-id','31337','--silent'],{stdio:'ignore',windowsHide:true});
let startupError;child.on('error',e=>{startupError=e;});
const client=createPublicClient({chain:foundry,transport:http(url)});
const report={schema:'flurbo.privacy-beta.local.v1',network:'disposable-local-chain',startedAt:new Date().toISOString(),checks:[],proofMilliseconds:null};
try{
  for(let i=0;i<40;i++){if(startupError)throw startupError;try{await client.getChainId();break;}catch{await new Promise(r=>setTimeout(r,250));}}
  assert.equal(await client.getChainId(),31337);
  const accounts=await client.request({method:'eth_accounts'});
  const wallet=createWalletClient({chain:foundry,transport:http(url),account:accounts[0]});
  const contracts=compile(),deployed=new Map();
  async function deploy(name,args=[]) {
    const a=artifact(contracts,name);let code=a.evm.bytecode.object;
    for(const [file,libraries] of Object.entries(a.evm.bytecode.linkReferences))for(const [library,refs] of Object.entries(libraries)){
      const address=deployed.get(file+':'+library)||await deploy(library);
      for(const {start,length} of refs)code=code.slice(0,start*2)+address.slice(2).padStart(length*2,'0')+code.slice((start+length)*2);
    }
    const hash=await wallet.deployContract({abi:a.abi,bytecode:'0x'+code,args});
    const receipt=await client.waitForTransactionReceipt({hash});assert.equal(receipt.status,'success');
    deployed.set(a.file+':'+name,receipt.contractAddress);return receipt.contractAddress;
  }
  const verifier=await deploy('SemaphoreVerifier'),semaphore=await deploy('Semaphore',[verifier]),token=await deploy('TestAsset'),vault=await deploy('NoteVault',[semaphore,token,1_000_000n]);
  const abi=artifact(contracts,'NoteVault').abi,tokenAbi=artifact(contracts,'TestAsset').abi,semAbi=artifact(contracts,'Semaphore').abi;
  const read=(functionName,args=[])=>client.readContract({address:vault,abi,functionName,args});
  async function send(address,abi,functionName,args=[],account=accounts[0]) {
    const {request}=await client.simulateContract({address,abi,functionName,args,account});
    const receipt=await client.waitForTransactionReceipt({hash:await wallet.writeContract(request)});assert.equal(receipt.status,'success');return receipt;
  }
  const members=[],notes=Array.from({length:4},()=>newNote());
  for(let i=0;i<notes.length;i++){
    await send(token,tokenAbi,'mint',[accounts[i],1_000_000n]);await send(token,tokenAbi,'approve',[vault,1_000_000n],accounts[i]);
    await send(vault,abi,'deposit',[notes[i].commitment],accounts[i]);members.push(notes[i].commitment);
  }
  report.checks.push('Four equal deposits backed by exact token transfers');
  assert.equal(await read('outstanding'),4n);
  await assert.rejects(send(vault,abi,'deposit',[notes[0].commitment]));
  const groupId=await read('groupId'),scope=await read('scope');
  assert.equal(await client.readContract({address:semaphore,abi:semAbi,functionName:'getMerkleTreeRoot',args:[groupId]}),new Group(members).root);
  const binding=`31337:${vault}:${token}:1000000`,backup=await encryptNote(notes[0],'disposable demo backup password',binding);
  const recovered=await decryptNote(backup,'disposable demo backup password',binding);
  const deadline=(await client.getBlock()).timestamp+3600n,recipient=accounts[8],message=await read('withdrawalMessage',[recipient,deadline]);
  console.log('Generating a real Semaphore proof locally; initial artifact download may take time.');
  const started=Date.now(),proof=await proveWithdrawal(recovered,members,scope,message,{wasm:fileURLToPath(new URL('../public/semaphore-8.wasm',import.meta.url)),zkey:fileURLToPath(new URL('../public/semaphore-8.zkey',import.meta.url))});
  report.proofMilliseconds=Date.now()-started;
  const tuple={...proof,merkleTreeDepth:BigInt(proof.merkleTreeDepth),merkleTreeRoot:BigInt(proof.merkleTreeRoot),nullifier:BigInt(proof.nullifier),message:BigInt(proof.message),scope:BigInt(proof.scope),points:proof.points.map(BigInt)};
  await assert.rejects(send(vault,abi,'withdraw',[accounts[9],deadline,tuple]));
  await assert.rejects(send(vault,abi,'withdraw',[recipient,deadline,{...tuple,scope:scope+1n}]));
  await assert.rejects(send(vault,abi,'withdraw',[recipient,deadline,{...tuple,points:tuple.points.map(()=>0n)}]));
  await assert.rejects(send(vault,abi,'withdraw',[recipient,deadline,{...tuple,merkleTreeRoot:1n}]));
  const snapshot=await client.request({method:'evm_snapshot'});
  await client.request({method:'evm_increaseTime',params:[3601]});await client.request({method:'evm_mine'});
  await assert.rejects(send(vault,abi,'withdraw',[recipient,deadline,tuple]));
  assert.equal(await client.request({method:'evm_revert',params:[snapshot]}),true);
  // An outsider can validate on Semaphore, but cannot burn our vault entitlement.
  await send(semaphore,semAbi,'validateProof',[groupId,tuple],accounts[7]);
  const receipt=await send(vault,abi,'withdraw',[recipient,deadline,tuple],accounts[7]);
  await assert.rejects(send(vault,abi,'withdraw',[recipient,deadline,tuple]));
  assert.equal(await read('outstanding'),3n);
  assert.equal(await client.readContract({address:token,abi:tokenAbi,functionName:'balanceOf',args:[vault]}),3_000_000n);
  assert.equal(await client.readContract({address:token,abi:tokenAbi,functionName:'balanceOf',args:[recipient]}),1_000_000n);
  report.checks.push('Encrypted backup restores proof identity','Real proof verified on EVM with separate relay sender','Wrong recipient, scope, root, expired deadline and forged proof rejected','External proof validation cannot consume entitlement','Double withdrawal rejected; remaining lots fully backed');
  report.vault=vault;report.verifierCodeHash=keccak256(await client.getCode({address:verifier}));report.withdrawalGas=receipt.gasUsed.toString();
  report.notice='All four identities and wallets were generated by this local test. This measures correctness, not a real anonymity set. Asset, lot, deposits, recipient and timing are public. No private market trade or public Monad deployment is established.';
  await mkdir(new URL('../../../target/privacy-beta/',import.meta.url),{recursive:true});
  await writeFile(new URL('../../../target/privacy-beta/local-report.json',import.meta.url),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
}finally{child.kill();}

// snarkjs worker threads can keep Node alive after the completed CLI rehearsal.
process.exit(0);
