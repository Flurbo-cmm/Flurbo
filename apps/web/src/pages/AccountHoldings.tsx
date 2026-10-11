import {useEffect,useState} from 'react';
import {amount,describeClaim,describeClaimAnswers,type Portfolio} from '../portfolio';
import {accountOwners,combineHoldings,type AccountHolding} from '../account-holdings';
import './portfolio.css';

type Read={rows:AccountHolding[];complete:boolean};

export default function AccountHoldings({account,wallets,namespace}:{account:string;wallets:string[];namespace:string}){
  const [reads,setReads]=useState<Record<string,Read>>({});
  const [busy,setBusy]=useState(true),[error,setError]=useState(false),[older,setOlder]=useState(false),[revision,setRevision]=useState(0);
  const identity=accountOwners(account,wallets).join(',');
  useEffect(()=>{
    const controller=new AbortController(),signal=controller.signal,owners=identity.split(',');
    const current=()=>!signal.aborted;
    setReads({});setBusy(true);setError(false);setOlder(false);
    const publish=(owner:string,rows:AccountHolding[],complete:boolean)=>{if(current())setReads(old=>({...old,[owner]:{rows,complete}}));};
    async function legacy(owner:string){
      const market=namespace==='learning'?'learning':'original',base=market==='learning'?'/api/markets/learning':'/api';
      const rows:AccountHolding[]=[];
      for(let page=0;current();page++){
        const response=await fetch(`${base}/portfolio?wallet=${owner}&page=${page}`,{credentials:'same-origin',cache:'no-store',signal:AbortSignal.any([signal,AbortSignal.timeout(20_000)])});
        if(!response.ok)throw Error('Holdings unavailable');
        const data:Portfolio=await response.json();
        if(data.wallet_address!==owner||data.market_id!==market||!data.snapshot)throw Error('Account mismatch');
        if(!data.index.complete){if(current())setOlder(true);publish(owner,rows,false);return;}
        if(data.snapshot.stale)throw Error('Stale holdings');
        rows.push(...(data.positions||[]).map(row=>({scope:row.scope,mask:String(row.mask),quantity:row.quantity_atoms,payoutAtoms:row.redeemable_atoms})));
        const complete=(page+1)*(data.page_size||20)>=(data.position_count||0);
        publish(owner,[...rows],complete);if(complete)return;
      }
    }
    async function run(){
      // Bound RPC pressure while still making progress across accounts.
      const queue=[...owners];
      await Promise.all(Array.from({length:Math.min(2,queue.length)},async()=>{
        while(queue.length&&current()){
          const owner=queue.shift()!;
          try{await legacy(owner);}catch{if(current())setError(true);}
        }
      }));
      if(current())setBusy(false);
    }
    void run();return()=>controller.abort();
  },[account,identity,namespace,revision]);
  const rows=combineHoldings(Object.values(reads).map(read=>read.rows));
  const incomplete=error||Object.values(reads).some(read=>!read.complete)||Object.keys(reads).length<identity.split(',').length;
  return <div className="portfolio-view account-holdings" aria-busy={busy}>
    <div className="portfolio-section-heading"><h2>Your shares</h2><button className="button button-outline" onClick={()=>setRevision(n=>n+1)}>{busy?'Refreshing…':'Refresh'}</button></div>
    {error&&<p role="alert">Some shares couldn’t be loaded. Refresh to complete your portfolio.</p>}
    <div className="portfolio-table"><table><thead><tr><th>Prediction</th><th>Shares</th><th>Redeemable test AUSD</th></tr></thead>
      <tbody>{rows.map(row=><tr key={`${row.scope}:${row.mask}`}><td><strong>{describeClaim(row.scope,Number(row.mask))}</strong><small>{describeClaimAnswers(row.scope,Number(row.mask))}</small></td><td><span className="holding-mobile-label" aria-hidden="true">Shares</span>{amount(row.quantity)}</td><td><span className="holding-mobile-label" aria-hidden="true">Redeemable test AUSD</span><span className="holding-payout-amount">{row.payoutAtoms===null?'Awaiting settlement':BigInt(row.payoutAtoms)===0n?'No payout':amount(row.payoutAtoms)}</span>
      </td></tr>)}</tbody></table></div>
    {!rows.length&&<p role="status">{busy?'Loading your shares…':incomplete||older?'Your shares could not all be checked yet. Refresh to try again.':'No shares in these markets yet.'}</p>}
    {rows.length>0&&(busy||incomplete)&&<p className="portfolio-freshness" role="status">{busy?'Loading remaining shares…':'Showing the shares checked so far.'}</p>}
    {older&&!busy&&<p className="portfolio-footnote">Older activity is still being indexed. Refresh later if a custom prediction is missing.</p>}
  </div>;
}
