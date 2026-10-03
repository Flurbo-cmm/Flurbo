import {accountDigest} from './agent-store.mjs';

// Read-only account aggregation. This never adds an agent wallet to the manual
// MetaMask link set or grants it signing/challenge permissions.
export async function agentPortfolio({store,links,account,origin,serviceFor}) {
  account=account.toLowerCase();
  const profiles=[...await store.list(account),...await store.listArchived(account)].filter(p=>p.kind==='runtime');
  const wallets=new Set(),executions=[],seen=new Set();
  const owners=new Map();
  async function available(address) {
    if(!owners.has(address))owners.set(address,Promise.all([store.agentWallet(address),links.ownerOf(address,origin)]).then(([claim,manual])=>
      (!claim||claim.owner===accountDigest(account))&&(!manual||manual.toLowerCase()===account)));
    return owners.get(address);
  }
  // Sequential agents bound Redis fanout; archived/replaced wallets remain
  // visible until another account claims them. Past verified trades remain.
  for(const p of profiles){
    const found=await store.get(account,p.id);if(!found)continue;
    const profile=found.profile;
    for(const address of new Set([profile.wallet,...(profile.walletHistory||[]).map(w=>w.address)].filter(Boolean)))
      if(await available(address))wallets.add(address);
    for(const e of found.state.runtime.executions){
      const v=e.verification,claim=e.intent?.claim,svc=serviceFor(e.namespace);
      if(e.status!=='confirmed'||!claim||!['buy','sell','redeem'].includes(e.intent.action)||!v?.from||!v.blockNumber||v.collateralAtoms==null||!svc)continue;
      const pool=svc.manifest.pool.toLowerCase(),key=pool+':'+e.hash;
      if(seen.has(key))continue;seen.add(key);
      executions.push({agentId:profile.id,agentName:profile.name,namespace:e.namespace,pool,owner:v.from,
        hash:e.hash,block:Number(v.blockNumber),timestamp:v.blockTimestamp,scope:claim.scope,mask:claim.mask,
        quantity:e.intent.quantityAtoms,cash:v.collateralAtoms,action:e.intent.action==='buy'?'Buy':e.intent.action==='sell'?'Sell':'Payout'});
    }
  }
  return {wallets:[...wallets].sort(),executions};
}
