import type {PilotState} from './pilot';

export function challengeUnavailable(state:PilotState,event:number,owner='',now=Date.now()/1000):string {
  const current=state.cases[event];
  if(!current || current.phase===0)return 'No answer has been proposed yet.';
  if(current.phase===2)return 'This answer has been challenged. The testnet reviewer panel decides the dispute.';
  if(current.phase===3)return 'This result is final. Its challenge period has ended.';
  if(Math.max(now,state.snapshot.timestamp)>=Number(current.challengeUntil))return 'The challenge period has ended.';
  if(owner&&current.asserter.toLowerCase()===owner.toLowerCase())return 'The wallet that proposed this answer cannot challenge it. Connect a different MetaMask wallet.';
  if(owner&&state.manifest.publication.reviewers.some(r=>r.address.toLowerCase()===owner.toLowerCase()))return 'Reviewer wallets cannot challenge. Connect a different MetaMask wallet.';
  return '';
}
