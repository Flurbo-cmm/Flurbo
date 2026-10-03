import {useEffect,useState} from 'react';
import {formatEther,formatUnits,parseEther,parseUnits,encodeFunctionData,erc20Abi} from 'viem';
import {TESTNET} from '../../server/network.mjs';
import {discoverWallets,type BrowserWallet} from '../auth/wallet-choice';

// Send test MON and test AUSD from the member's own MetaMask to their agent's wallet. The Flurbo AUSD
// dispenser only pays the wallet that calls it, so an agent wallet is funded by a normal transfer instead.
// Nothing here can move funds without a MetaMask confirmation, and it never sees the agent's key.
const uint=(v:unknown)=>{if(typeof v!=='string'||!/^0x[0-9a-f]+$/i.test(v))throw Error('Balance unavailable. Try refreshing.');return BigInt(v);};
async function rpc(method:string,params:unknown[]){
  const res=await fetch('/api/rpc',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({method,params}),signal:AbortSignal.timeout(15000)});
  const value=await res.json();
  if(!res.ok||value.error)throw Error('The network is unavailable. Try again shortly.');
  return value.result;
}
const MAX={mon:parseEther('2'),ausd:parseUnits('200',6)};
// The SDK keeps this much test MON back for fees (policy.gas.reserveWei) and does not trade below it.
const RESERVE=parseEther('0.2');

export default function AgentFunding({wallet}:{wallet:string}){
  const [balances,setBalances]=useState<{mon:bigint;ausd:bigint}|null>(null),[wallets,setWallets]=useState<BrowserWallet[]>([]);
  const [mon,setMon]=useState('0.5'),[ausd,setAusd]=useState('5'),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[hash,setHash]=useState('');
  const agent=wallet.toLowerCase();
  async function read(){
    try{
      const [m,a]=await Promise.all([rpc('eth_getBalance',[agent,'latest']),rpc('eth_call',[{to:TESTNET.cash,data:encodeFunctionData({abi:erc20Abi,functionName:'balanceOf',args:[agent as `0x${string}`]})},'latest'])]);
      setBalances({mon:uint(m),ausd:uint(a)});
    }catch{setBalances(null);}
  }
  useEffect(()=>{void read();return discoverWallets(w=>setWallets(list=>[...list,w]));},[agent]);
  async function send(kind:'mon'|'ausd'){
    if(busy)return;setBusy(true);setMessage('');setHash('');
    try{
      const p=wallets[0]?.provider;if(!p)throw Error('Install or unlock MetaMask to send test funds.');
      const accounts=await p.request({method:'eth_requestAccounts'}) as string[];
      const from=accounts?.[0]?.toLowerCase();if(!/^0x[0-9a-f]{40}$/.test(from||''))throw Error('Select a MetaMask account.');
      if(from===agent)throw Error('MetaMask is on the agent wallet itself. Switch to your own wallet to send funds to the agent.');
      if(await p.request({method:'eth_chainId'})!=='0x279f')throw Error('Select Monad testnet in MetaMask.');
      let amount:bigint;
      try{amount=kind==='mon'?parseEther(mon.trim()):parseUnits(ausd.trim(),6);}catch{throw Error('Enter an amount.');}
      if(amount<=0n||amount>MAX[kind])throw Error(kind==='mon'?'Send between 0 and 2 test MON.':'Send between 0 and 200 test AUSD.');
      const tx=kind==='mon'?{from,to:agent,value:'0x'+amount.toString(16),chainId:'0x279f'}
        :{from,to:TESTNET.cash,value:'0x0',chainId:'0x279f',data:encodeFunctionData({abi:erc20Abi,functionName:'transfer',args:[agent as `0x${string}`,amount]})};
      const gas=uint(await p.request({method:'eth_estimateGas',params:[tx]}))*120n/100n,gasPrice=uint(await p.request({method:'eth_gasPrice'}))*2n;
      const own=uint(await rpc('eth_getBalance',[from,'latest']));
      if(own<gas*gasPrice+(kind==='mon'?amount:0n))throw Error('Your wallet does not have enough test MON for this transfer and its network fee.');
      setMessage('Confirm the transfer in MetaMask.');
      const sent=await p.request({method:'eth_sendTransaction',params:[{...tx,gas:'0x'+gas.toString(16),gasPrice:'0x'+gasPrice.toString(16)}]});
      if(typeof sent!=='string'||!/^0x[0-9a-f]{64}$/i.test(sent))throw Error('MetaMask did not return a transaction.');
      setHash(sent);setMessage(`Sent. The agent wallet balance updates once the transfer confirms.`);
      setTimeout(()=>void read(),6000);
    }catch(e){const x=e as {code?:number;message?:string};setMessage(x?.code===4001?'Cancelled in MetaMask. Nothing was sent.':x instanceof Error&&x.message?x.message:'The transfer could not be sent. Check MetaMask activity before trying again.');}
    finally{setBusy(false);}
  }
  const shown=(v:bigint,d:number)=>Number(d===18?formatEther(v):formatUnits(v,d)).toLocaleString(undefined,{maximumFractionDigits:3});
  return <div className="agents-funding">
    <h3>Fund this agent</h3>
    <p className="agents-fine">The agent wallet pays its own network fees in test MON and trades with its own test AUSD. Send both from your MetaMask wallet. The Flurbo AUSD dispenser only pays the wallet that asks, so it cannot send to the agent directly.</p>
    <p>{balances?`Agent wallet holds ${shown(balances.mon,18)} test MON and ${shown(balances.ausd,6)} test AUSD.`:'Agent wallet balance unavailable.'} <button className="text-link" disabled={busy} onClick={()=>void read()}>Refresh</button></p>
    <p className="agents-fine">The runtime always keeps {formatEther(RESERVE)} test MON for fees and will not trade below it, so send more than that: 0.5 test MON and 5 test AUSD are plenty to start.</p>
    {balances&&balances.mon<=RESERVE&&<p className="agents-note" role="status">The agent holds {shown(balances.mon,18)} test MON, not more than the {formatEther(RESERVE)} it keeps for fees. It will not trade until you send more.</p>}
    <div className="agents-pair">
      <label>Test MON to send<input inputMode="decimal" value={mon} onChange={e=>setMon(e.target.value)} disabled={busy}/></label>
      <button className="button button-outline" disabled={busy} onClick={()=>void send('mon')}>Send test MON</button>
      <label>Test AUSD to send<input inputMode="decimal" value={ausd} onChange={e=>setAusd(e.target.value)} disabled={busy}/></label>
      <button className="button button-outline" disabled={busy} onClick={()=>void send('ausd')}>Send test AUSD</button>
    </div>
    {message&&<p role="status" className="agents-fine">{message}{hash&&<> <a className="text-link" href={`https://testnet.monadscan.com/tx/${hash}`} target="_blank" rel="noreferrer">View transaction</a></>}</p>}
  </div>;
}
