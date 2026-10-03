// Realized trading PnL, in collateral atoms. This is not mark-to-market equity.
// Cost basis is kept per on-chain owner and claim; linking wallets never moves it.
export type ActivityLog={name:string;hash:string;index:number;block:number;timestamp?:number;args:Record<string,unknown>};
export type TradeActivity={namespace:string;pool:string;owner:string;scope:number;mask:string;quantity:bigint;cash:bigint;action:'Buy'|'Sell'|'Payout';hash:string;index:number;block:number;timestamp?:number};
export function accountActivity(namespace:string,pool:string,logs:ActivityLog[],owners:string[]):TradeActivity[]{
  const allowed=new Set(owners.map(x=>x.toLowerCase())),seen=new Set<string>(),rows:TradeActivity[]=[];
  for(const l of logs){
    if(!['Traded','Redeemed'].includes(l.name))continue;
    const a=l.args,owner=String(a.trader||a.owner||'').toLowerCase(),key=`${pool}:${l.hash}:${l.index}`;
    if(!allowed.has(owner)||seen.has(key))continue;
    try{
      const quantity=BigInt(String(a.quantity)),cash=BigInt(String(a.collateralAmount)),mask=BigInt(String(a.mask)).toString(),scope=Number(a.scope);
      if(quantity<=0n||cash<0n||!Number.isInteger(scope)||!Number.isSafeInteger(l.block)||!Number.isSafeInteger(l.index)||!/^0x[0-9a-f]{64}$/i.test(l.hash))continue;
      if(l.name==='Traded'&&typeof a.isBuy!=='boolean')continue;
      seen.add(key);rows.push({namespace,pool,owner,scope,mask,quantity,cash,action:l.name==='Redeemed'?'Payout':a.isBuy?'Buy':'Sell',hash:l.hash,index:l.index,block:l.block,timestamp:l.timestamp});
    }catch{/* Incomplete records cannot establish cost basis. */}
  }
  return rows.sort((a,b)=>a.block-b.block||a.index-b.index||a.pool.localeCompare(b.pool));
}
export const positionKey=(pool:string,owner:string,scope:number,mask:string)=>`${pool.toLowerCase()}:${owner.toLowerCase()}:${scope}:${BigInt(mask)}`;
export function realizedPerformance(trades:TradeActivity[]){
  const inventory=new Map<string,{quantity:bigint;cost:bigint}>();let realized=0n,valid=true;
  const points:{trade:TradeActivity;value:bigint}[]=[];
  for(const trade of [...trades].sort((a,b)=>a.block-b.block||a.index-b.index)){
    const key=positionKey(trade.pool,trade.owner,trade.scope,trade.mask),held=inventory.get(key)||{quantity:0n,cost:0n};
    if(trade.action==='Buy'){held.quantity+=trade.quantity;held.cost+=trade.cash;}
    else if(held.quantity<trade.quantity){valid=false;held.quantity=0n;held.cost=0n;}
    else{
      const cost=trade.quantity===held.quantity?held.cost:held.cost*trade.quantity/held.quantity;
      realized+=trade.cash-cost;held.quantity-=trade.quantity;held.cost-=cost;points.push({trade,value:realized});
    }
    inventory.set(key,held);
  }
  return {realized,points,valid,inventory};
}
