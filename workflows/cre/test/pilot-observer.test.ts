import { test, expect } from 'bun:test';
import { collectPilotEvidence } from '../src/pilot-observer';
import { releaseEvent } from '../src/github-release';
import { prepareEventDraft } from '../src/event-draft';

test('CRE observer binds real-source retrieval to the configured on-chain draft and never writes a result',()=>{
  const now=1800000000,pool='0x'+'11'.repeat(20),resolver='0x'+'22'.repeat(20),rulesHash='0x'+'33'.repeat(32),blockHash='0x'+'44'.repeat(32);
  const draft={schema:'flurbo.event-draft.v1',status:'draft',chainId:10143,clusterId:'fixture',title:'Test fixture',closesAt:now-200,
    events:[releaseEvent({repository:'ethereum/go-ethereum',tag:'v99.0.0'},'a',now-100,now+100),releaseEvent({repository:'paradigmxyz/reth',tag:'v99.0.0'},'b',now-100,now+100)],exceptionPolicy:null,disputeModel:'undecided',disputePolicy:null};
  const config={schema:'flurbo.pilot-observer.v1',draft,pool,resolver,rulesHash},trigger={eventId:'a',blockNumber:'100',blockHash};
  let mismatch=false,sourceStatus=200;const calls:string[]=[];
  const http=(request:any)=>{
    calls.push(request.url);
    if(request.method==='POST') {
      const inputs=JSON.parse(request.body);expect(inputs.map((r:any)=>r.method)).toEqual(['eth_chainId','eth_getBlockByNumber','eth_call','eth_call','eth_call']);
      const values=['0x279f',{number:'0x64',hash:blockHash,timestamp:'0x'+now.toString(16)},mismatch?blockHash:rulesHash,prepareEventDraft(draft,now).draftHash,'0x'+pool.slice(2).padStart(64,'0')];
      return {status:200,body:JSON.stringify(values.map((result,i)=>({jsonrpc:'2.0',id:i+1,result})))};
    }
    return {status:sourceStatus,body:JSON.stringify({id:1,url:'https://api.github.com/repos/ethereum/go-ethereum/releases/1',html_url:'https://github.com/ethereum/go-ethereum/releases/tag/v99.0.0',tag_name:'v99.0.0',draft:false,prerelease:false,published_at:new Date((now-50)*1000).toISOString().replace('.000Z','Z')})};
  };
  const result=collectPilotEvidence(config,trigger,now,http);
  expect(result.observation.status).toBe('candidate');expect(result.observation.final).toBe(false);
  expect(calls).toEqual(['https://testnet-rpc.monad.xyz','https://api.github.com/repos/ethereum/go-ethereum/releases/tags/v99.0.0']);
  sourceStatus=404;expect(collectPilotEvidence(config,trigger,now,http).observation.status).toBe('needs-review');
  mismatch=true;const before=calls.length;expect(()=>collectPilotEvidence(config,trigger,now,http)).toThrow();expect(calls.length).toBe(before+1);
  expect(()=>collectPilotEvidence(config,{...trigger,blockHash:rulesHash},now,http)).toThrow();
});
