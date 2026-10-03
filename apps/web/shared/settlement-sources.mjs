// The exact sources settlement reads for each question, so members and their bots can check the same record the
// resolver checks, before settlement. Pure and shared by the server (agent API) and the browser (market pages).
// Derived only from the committed manifest; it never adds a source the rules do not already name.
import {ACTIVITY_MODE} from './ethereum-activity.mjs';

export const RELEASE_RULE='github-stable-release-publication.v1';
// Must match ETHEREUM_SOURCES in server/ethereum-activity.mjs and the finality rule each activity question commits.
export const ETHEREUM_RPC_SOURCES=['https://ethereum-rpc.publicnode.com','https://eth.drpc.org'];

// One entry per question, in question order: null for practice questions with scripted outcomes, or when the
// manifest names no machine-checked source for that question.
// request 'GET' means the address can be opened in a browser or fetched by a bot; 'JSON-RPC' means it is an
// Ethereum node endpoint that answers JSON-RPC requests, not a web page.
export function settlementSources(manifest){
  const publication=manifest?.publication,events=publication?.draft?.events;
  if(!Array.isArray(events))return [];
  return events.map((event,index)=>{
    if(publication.mode==='rehearsal')return null;
    const rule=Array.isArray(publication.settlementRules)?publication.settlementRules[index]:null;
    if(String(event?.source?.recordId||'').startsWith('settlement-rule:')&&Array.isArray(rule?.source?.urls)&&rule.source.urls.length)
      return {method:String(rule.source.adapter),request:'GET',urls:rule.source.urls.map(String)};
    const release=String(event?.source?.recordId||'').match(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)@(v\d{1,4}\.\d{1,4}\.\d{1,4})$/);
    if(release&&String(event.source.selectionRule||'').startsWith(RELEASE_RULE+':'))
      return {method:RELEASE_RULE,request:'GET',urls:[`https://api.github.com/repos/${release[1]}/releases/tags/${release[2]}`]};
    if(publication.mode===ACTIVITY_MODE&&String(event?.source?.recordId||'').startsWith('ethereum-activity.v1:'))
      return {method:'ethereum-activity.v1',request:'JSON-RPC',urls:[...ETHEREUM_RPC_SOURCES]};
    return null;
  });
}
