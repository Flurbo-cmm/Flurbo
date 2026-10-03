import { cre, bytesToBase64, consensusIdenticalAggregation, decodeJson, Runner, type Runtime, type HTTPPayload } from '@chainlink/cre-sdk';
import { collectPilotEvidence, pilotObserverSchema, type ObserverConfig } from './pilot-observer';

function onPilotObservation(runtime:Runtime<ObserverConfig>,payload:HTTPPayload):string {
  const input=decodeJson(payload.input),now=Math.floor(runtime.now().getTime()/1000);
  const http=new cre.capabilities.HTTPClient();
  const result=http.sendRequest(runtime,requester=>JSON.stringify(collectPilotEvidence(runtime.config,input,now,request=>{
    const response=requester.sendRequest({url:request.url,method:request.method,headers:request.headers,
      body:request.body?bytesToBase64(new TextEncoder().encode(request.body)):undefined,timeout:'15s'}).result();
    return {status:response.statusCode,body:new TextDecoder('utf-8',{fatal:true}).decode(response.body)};
  })),consensusIdenticalAggregation<string>())().result();
  runtime.log('Pilot source observation completed; no assertion or settlement transaction submitted.');
  return result;
}
export async function main(){const runner=await Runner.newRunner<ObserverConfig>({configSchema:pilotObserverSchema});await runner.run(()=>[cre.handler(new cre.capabilities.HTTPCapability().trigger({}),onPilotObservation)]);}
main();
