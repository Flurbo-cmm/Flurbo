import {createServer} from 'node:http';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createLocalSettlementCommand} from '../server/local-settlement-command.mjs';
import {createSettlementStores,settlementPacketHandler} from '../server/settlement-persistence.mjs';
import {pilotEvidence} from '../server/pilot.mjs';
import {localStateDirectory} from './run-local-settlement-rehearsal.mjs';
import {requestLimits,CapacityError} from '../server/request-limits.mjs';

// Deliberately separate from the web application. A rehearsal tunnel must point
// only here: no accounts, credentials, signing, configuration or write endpoints.
export function evidenceGateway({archive,packetStore}){
  const packets=settlementPacketHandler(packetStore);
  const limits=requestLimits();
  return createServer({requestTimeout:10000,headersTimeout:5000,maxHeaderSize:8192},async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Content-Security-Policy',"default-src 'none'; frame-ancestors 'none'");
    res.setHeader('Referrer-Policy','no-referrer');
    if(!['GET','HEAD'].includes(req.method)){res.writeHead(405,{Allow:'GET, HEAD'});res.end();return;}
    if(typeof req.url!=='string'||req.url.length>512){res.writeHead(404);res.end();return;}
    try{limits.localTake('evidence-gateway',120);}
    catch(error){res.writeHead(error instanceof CapacityError?429:503,{'Cache-Control':'no-store','Retry-After':'60'});res.end();return;}
    if(req.url==='/healthz'){
      res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});
      res.end(req.method==='HEAD'?undefined:JSON.stringify({service:'flurbo-rehearsal-public-evidence',readOnly:true}));return;
    }
    try{
      if(await packets(req,res))return;
      const match=/^\/api\/pilot\/evidence\/(0x[0-9a-f]{64})$/.exec(req.url);
      if(match){
        const body=await archive.get(match[1]);
        res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'public, max-age=31536000, immutable','Content-Length':Buffer.byteLength(body)});
        res.end(req.method==='HEAD'?undefined:body);return;
      }
    }catch{res.writeHead(404,{'Cache-Control':'no-store'});res.end();return;}
    res.writeHead(404,{'Cache-Control':'no-store'});res.end();
  });
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  (async()=>{
    const [path,portValue,...extra]=process.argv.slice(2),port=Number(portValue||18868);
    if(!path||extra.length||!Number.isSafeInteger(port)||port<1024||port>65535)throw Error('Invalid gateway arguments');
    const directory=localStateDirectory(path),command=await createLocalSettlementCommand({directory:resolve(directory,'store')});
    const {packetStore}=createSettlementStores({command});
    const server=evidenceGateway({archive:pilotEvidence(command,'https://rehearsal.invalid'),packetStore});
    server.listen(port,'127.0.0.1',()=>console.log(JSON.stringify({service:'rehearsal-evidence-only',port,bind:'127.0.0.1'})));
    for(const event of ['SIGINT','SIGTERM'])process.once(event,()=>server.close());
  })().catch(()=>{console.error('Evidence-only gateway could not start. Sensitive details withheld.');process.exitCode=1;});
}
