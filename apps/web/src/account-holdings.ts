export type AccountHolding = {scope:number;mask:string;quantity:string;payoutAtoms:string|null};

// Combine display balances only. Redemption remains with each on-chain owner;
// sum their already-rounded payouts instead of recalculating an aggregate payout.
export function combineHoldings(groups:AccountHolding[][]):AccountHolding[] {
  const rows=new Map<string,AccountHolding>();
  for(const group of groups)for(const row of group){
    if(BigInt(row.quantity)===0n)continue;
    const key=`${row.scope}:${BigInt(row.mask)}`,old=rows.get(key);
    rows.set(key,{...row,mask:BigInt(row.mask).toString(),quantity:(BigInt(old?.quantity||0)+BigInt(row.quantity)).toString(),
      payoutAtoms:!old?row.payoutAtoms:old.payoutAtoms===null||row.payoutAtoms===null?null:(BigInt(old.payoutAtoms)+BigInt(row.payoutAtoms)).toString()});
  }
  return [...rows.values()].sort((a,b)=>a.scope-b.scope||Number(BigInt(b.mask)-BigInt(a.mask)));
}

export function accountOwners(account:string,wallets:string[]):string[]{
  return [...new Set([...wallets,account].map(address=>address.toLowerCase()))];
}
