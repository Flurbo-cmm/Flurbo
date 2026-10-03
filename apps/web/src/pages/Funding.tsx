import {linkedWallets,linkTradingWallet} from '../wallet-links';
import {watchTradingWallet} from '../auth/trading-session';
import {useEffect, useRef, useState} from 'react';
import {formatUnits, toFunctionSelector} from 'viem';
import {Link} from 'wouter';
import {ArrowUpRight} from 'lucide-react';
import {useAuth} from '../auth/context';
import {discoverWallets, type BrowserWallet} from '../auth/wallet-choice';
import {walletKey, tradingWalletKey} from '../portfolio';
import {TESTNET} from '../../server/network.mjs';
import './funding.css';

type Network = typeof TESTNET & {flurboFaucet?:boolean;starterMon?:string|null};
type Pending = {hash:string;owner:string;faucet:string};
const uint = (v:unknown) => { if (typeof v !== 'string' || !/^0x[0-9a-f]+$/i.test(v)) throw Error('Balance unavailable. Try refreshing.'); return BigInt(v); };
async function rpc(method:string, params:unknown[]) {
  const res = await fetch('/api/rpc', {method:'POST', credentials:'same-origin', headers:{'Content-Type':'application/json'}, body:JSON.stringify({method,params}), signal:AbortSignal.timeout(15000)});
  const value = await res.json();
  if (!res.ok || value.error) throw Error('The network is unavailable. Try again shortly.');
  return value.result;
}
function fundingError(error:unknown, sending=false) {
  const e=error as {code?:number;message?:string;data?:unknown};
  if (e?.code===4001) return 'Request cancelled in MetaMask. No funding was confirmed.';
  const data=JSON.stringify(e?.data ?? '');
  if (data.includes('356680b7')) return 'The test AUSD dispenser is empty. Please try again after it is refilled.';
  if (data.includes(toFunctionSelector('TooSoon()').slice(2))) return 'You have already claimed today. Come back 24 hours after your last claim.';
  if (sending) return 'Submission status is uncertain. Check MetaMask activity before requesting again.';
  return e instanceof Error && /^(Install|Select|Wallet|Sign in|Get test MON|The |Balance|You |Faucet)/.test(e.message) ? e.message : 'The faucet could not complete this request. Refresh balances and try again.';
}

export default function Funding({expanded=false}:{expanded?:boolean}) {
  const {state}=useAuth();
  const [wallets,setWallets]=useState<BrowserWallet[]>([]),[owner,setOwner]=useState('');
  const [walletStatus,setWalletStatus]=useState('checking');
  const [correctChain,setCorrectChain]=useState(false);
  const activeOwner=useRef('');
  const [network,setNetwork]=useState<Network|null>(null),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
  const [balances,setBalances]=useState<{ausd:bigint;mon:bigint;stock:bigint;nextClaim:bigint}|null>(null);
  const [pending,setPending]=useState<Pending|null>(null),[checking,setChecking]=useState(false),[uncertain,setUncertain]=useState(false);
  const providerRef=useRef<BrowserWallet['provider']|null>(null), generation=useRef(0), checkingRef=useRef(false), busyRef=useRef(false);
  const key='flurbo.faucet.pending.v1:'+state.address;
  useEffect(()=>discoverWallets(w=>setWallets(old=>old.some(v=>v.provider===w.provider)?old:[...old,w])),[]);
  useEffect(()=>{
    const c=new AbortController();
    void fetch('/api/network',{credentials:'same-origin',signal:AbortSignal.any([c.signal,AbortSignal.timeout(10000)])}).then(async r=>{if(!r.ok)throw Error();return r.json();}).then(n=>{
      if(n.chain_id!==10143||n.environment!=='public_testnet'||n.cash!==TESTNET.cash||!/^0x[0-9a-f]{40}$/i.test(n.faucet))throw Error();
      if(!c.signal.aborted)setNetwork(n);
    }).catch(()=>{if(!c.signal.aborted)setMessage('Funding settings are unavailable. Reload to try again.');});
    try {const p=JSON.parse(localStorage.getItem(key)||'null');if(p&&/^0x[0-9a-f]{64}$/i.test(p.hash)&&[p.owner,p.faucet].every(a=>/^0x[0-9a-f]{40}$/i.test(a)))setPending(p);}catch{}
    return()=>c.abort();
  },[key]);
  useEffect(()=>{
    const p=wallets[0]?.provider;
    if(!p||!state.address){setWalletStatus('disconnected');return;}
    const stop=watchTradingWallet({provider:p,account:state.address,links:linkedWallets,publish:value=>{
      setWalletStatus(value.status);
      if(activeOwner.current===value.owner&&value.status!=='checking')return;
      generation.current++;activeOwner.current=value.owner;providerRef.current=value.owner?p:null;setOwner(value.owner);setBalances(null);setCorrectChain(false);
    }});
    return()=>{generation.current++;providerRef.current=null;stop();};
  },[wallets[0]?.provider,state.address]);
  useEffect(()=>{let active=true;if(owner&&network){void readBalances().catch(e=>{if(active)setMessage(fundingError(e));});void providerRef.current?.request({method:'eth_chainId'}).then(chain=>{if(active)setCorrectChain(chain==='0x279f');}).catch(()=>{});}return()=>{active=false;};},[owner,network]);
  // Test MON arrives from the faucet in another tab. Re-read when the member comes back,
  // and check briefly while none is visible yet, so the AUSD step is not left disabled on stale balances.
  useEffect(()=>{
    if(!owner||!network)return;
    const refresh=()=>{if(!document.hidden&&!busyRef.current)void readBalances().catch(()=>{});};
    window.addEventListener('focus',refresh);document.addEventListener('visibilitychange',refresh);
    return()=>{window.removeEventListener('focus',refresh);document.removeEventListener('visibilitychange',refresh);};
  },[owner,network]);
  const waitingForMon=!!owner&&!!network&&balances?.mon===0n;
  useEffect(()=>{
    if(!waitingForMon)return;
    let tries=0;
    const timer=setInterval(()=>{if(++tries>30){clearInterval(timer);return;}if(!document.hidden&&!busyRef.current)void readBalances().catch(()=>{});},10000);
    return()=>clearInterval(timer);
  },[waitingForMon,owner,network]);
  async function readBalances(address=owner, version=generation.current) {
    if(!address||!network)return;
    const balanceOf=(account:string)=>rpc('eth_call',[{to:TESTNET.cash,data:'0x70a08231'+account.slice(2).padStart(64,'0')},'latest']);
    const values=await Promise.all([balanceOf(address),rpc('eth_getBalance',[address,'latest']),balanceOf(network.faucet),network.flurboFaucet?rpc('eth_call',[{to:network.faucet,data:toFunctionSelector('nextClaimAt(address)')+address.slice(2).padStart(64,'0')},'latest']):'0x0']);
    if(version===generation.current)setBalances({ausd:uint(values[0]),mon:uint(values[1]),stock:uint(values[2]),nextClaim:uint(values[3])});
  }
  async function connect(switchAccount=false) {
    if(busyRef.current||!network)return;busyRef.current=true;setBusy(true);setMessage('');
    try {
      const p=wallets[0]?.provider;if(!p)throw Error('Install MetaMask or open Flurbo in the MetaMask browser.');
      if(switchAccount)await p.request({method:'wallet_requestPermissions',params:[{eth_accounts:{}}]});
      await p.request({method:'eth_requestAccounts'});
      if(await p.request({method:'eth_chainId'})!=='0x279f'){
        try{await p.request({method:'wallet_switchEthereumChain',params:[{chainId:'0x279f'}]});}
        catch(e){if((e as any)?.code!==4902)throw e;await p.request({method:'wallet_addEthereumChain',params:[{chainId:'0x279f',chainName:'Monad Testnet',nativeCurrency:{name:'MON',symbol:'MON',decimals:18},rpcUrls:[TESTNET.rpc],blockExplorerUrls:[TESTNET.explorer]}]});}
      }
      const version=generation.current,accounts=await p.request({method:'eth_accounts'});
      if(!Array.isArray(accounts)||!/^0x[0-9a-f]{40}$/i.test(accounts[0]||''))throw Error('Select a MetaMask account.');
      if(await p.request({method:'eth_chainId'})!=='0x279f')throw Error('Select Monad testnet in MetaMask and reconnect.');
      const address=accounts[0].toLowerCase();if(!state.address)throw Error('Sign in first.');
      await linkTradingWallet(p,state.address,address,()=>version===generation.current);
      if(version!==generation.current)throw Error('Wallet changed. Reconnect MetaMask.');
      providerRef.current=p;setOwner(address);
      activeOwner.current=address;setCorrectChain(true);
      try{sessionStorage.setItem(walletKey(state.address),address);sessionStorage.setItem(tradingWalletKey(state.address),address);}catch{}
      await readBalances(address,version);
    }catch(e){setMessage(fundingError(e));}finally{busyRef.current=false;setBusy(false);}
  }
  async function requestFunds() {
    if(busyRef.current||!owner||!network||pending||uncertain)return;busyRef.current=true;setBusy(true);
    const version=generation.current,p=providerRef.current;let sending=false;
    setMessage('Confirm the test AUSD request in MetaMask.');
    try{
      if(!p)throw Error('Select MetaMask first.');
      const block=await rpc('eth_getBlockByNumber',['latest',false]);
      const walletBlock=await p.request({method:'eth_getBlockByNumber',params:[block.number,false]}) as {hash?:string};
      if(!block.hash||walletBlock?.hash?.toLowerCase()!==block.hash.toLowerCase())throw Error('Wallet network does not match Monad testnet. Reconnect.');
      const tx={from:owner,to:network.faucet,data:TESTNET.faucetSelector+owner.slice(2).padStart(64,'0'),value:'0x0',chainId:'0x279f'};
      await p.request({method:'eth_call',params:[tx,'latest']});
      const gas=uint(await p.request({method:'eth_estimateGas',params:[tx]}))*120n/100n;
      const gasPrice=uint(await p.request({method:'eth_gasPrice'}))*2n;
      if(gas<=0n||gas>1000000n||gasPrice<=0n)throw Error('Faucet gas estimate unavailable.');
      if(uint(await rpc('eth_getBalance',[owner,'latest']))<gas*gasPrice)throw Error('Get test MON for network fees first, then refresh your balance.');
      const accounts=await p.request({method:'eth_accounts'});
      if(version!==generation.current||!Array.isArray(accounts)||accounts[0]?.toLowerCase()!==owner||await p.request({method:'eth_chainId'})!=='0x279f')throw Error('Wallet changed. Reconnect MetaMask.');
      sending=true;
      const hash=await p.request({method:'eth_sendTransaction',params:[{...tx,gas:'0x'+gas.toString(16),gasPrice:'0x'+gasPrice.toString(16)}]});
      if(typeof hash!=='string'||!/^0x[0-9a-f]{64}$/i.test(hash))throw Error();
      const saved={hash,owner,faucet:network.faucet};
      try{localStorage.setItem(key,JSON.stringify(saved));}catch{}
      setPending(saved);setMessage('Request sent. Waiting for confirmation…');
    }catch(e){if(sending&&(e as any)?.code!==4001)setUncertain(true);setMessage(fundingError(e,sending));}
    finally{busyRef.current=false;setBusy(false);}
  }
  // Free test MON is sent automatically once when an account links its first wallet. The page shows
  // whether it was sent, offers a retry if the automatic send did not happen, or explains today's cap.
  const [starter,setStarter]=useState<{status:'sent'|'available'|'exhausted'|'disabled';note?:string}|null>(null);
  async function readStarter(){
    try{const r=await fetch('/api/fund/starter',{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(15000)});if(r.ok){const v=await r.json();if(['sent','available','exhausted','disabled'].includes(v.status))setStarter({status:v.status});}}catch{}
  }
  useEffect(()=>{if(owner&&network?.starterMon)void readStarter();},[owner,network?.starterMon,balances?.mon===0n]);
  async function requestStarterMon() {
    if(busyRef.current||!owner||!network?.starterMon)return;busyRef.current=true;setBusy(true);setMessage('');
    try{
      const response=await fetch('/api/fund/starter',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({wallet:owner}),signal:AbortSignal.timeout(30000)});
      const result=await response.json().catch(()=>({}));
      const reason=typeof result.error==='string'?result.error:'Free test MON could not be sent right now. Use the Monad faucet.';
      if(!response.ok){setStarter(result.code==='DAILY_LIMIT'?{status:'exhausted',note:reason}:result.code==='ALREADY_SENT'?{status:'sent',note:reason}:{status:'available',note:reason});return;}
      setStarter({status:'sent'});
      setTimeout(()=>void readBalances().catch(()=>{}),5000);
    }catch{setStarter({status:'available',note:'Free test MON could not be sent right now. Use the Monad faucet.'});}
    finally{busyRef.current=false;setBusy(false);}
  }
  async function checkStatus() {
    if(!pending||checkingRef.current)return;checkingRef.current=true;setChecking(true);
    try{
      const receipt=await rpc('eth_getTransactionReceipt',[pending.hash]);
      if(!receipt){setMessage('Still waiting for confirmation. Your request is saved if you leave this page.');return;}
      if(receipt.transactionHash?.toLowerCase()!==pending.hash.toLowerCase()||receipt.to?.toLowerCase()!==pending.faucet.toLowerCase()||receipt.from?.toLowerCase()!==pending.owner.toLowerCase()||!['0x0','0x1'].includes(receipt.status))throw Error();
      try{localStorage.removeItem(key);}catch{}
      setPending(null);
      setMessage(receipt.status==='0x1'?'Test AUSD request confirmed. You can return to the markets.':'The request reverted. Refresh balances before trying again.');
      await readBalances();
    }catch{setMessage('Confirmation is unavailable. Check the transaction below before retrying.');}
    finally{checkingRef.current=false;setChecking(false);}
  }
  useEffect(()=>{if(!pending)return;let tries=0;void checkStatus();const timer=setInterval(()=>{if(++tries>=15){clearInterval(timer);return;}if(!document.hidden)void checkStatus();},8000);return()=>clearInterval(timer);},[pending?.hash,owner]);
  const empty=balances && balances.stock<(network?.flurboFaucet?50000000n:10000000000n);
  const cooldown=balances&&balances.nextClaim>BigInt(Math.floor(Date.now()/1000));
  const monReady=!!balances&&balances.mon>0n, ausdReady=!!balances&&balances.ausd>0n;
  // Say why the request button is disabled; the dispenser and cooldown cases have their own messages above.
  const blockedReason=busy||empty||cooldown||uncertain?'':!owner?'Connect and link your MetaMask wallet above first.':pending?'Your last request is still being checked. Use Check status below.':!correctChain?'Switch MetaMask to Monad testnet first.':!balances?'Balances are loading. If this persists, refresh balances.':balances.mon===0n?'Get test MON first. Balances update when you return to this page, or use Refresh balances.':'';
  const content=<div className="funding-card">
    <section className="panel funding-wallet" aria-label="Your trading wallet">
      <div className="panel-head"><h2>Your trading wallet</h2>{owner&&<code className="address funding-address" title={owner}>{owner.slice(0,8)}…{owner.slice(-6)}</code>}</div>
      <p className="muted">Test funds go to MetaMask. Your Mera account keeps you signed in.</p>
      {balances&&<dl className="funding-balances"><div><dt>Trading balance</dt><dd>{formatUnits(balances.ausd,6)} AUSD</dd></div><div><dt>MON balance, for transaction fees</dt><dd>{Number(formatUnits(balances.mon,18)).toFixed(4)} MON</dd></div></dl>}
      {owner&&!balances&&<div className="funding-balances" aria-hidden="true"><span className="skeleton" style={{height:44}}/><span className="skeleton" style={{height:44}}/></div>}
      <div className="funding-actions"><button className={owner?'btn btn-secondary':'btn btn-primary'} disabled={busy||!network} onClick={()=>void connect(!!owner)}>{busy?'Check MetaMask...':owner?'Switch wallet':walletStatus==='checking'?'Checking wallet...':walletStatus==='unlinked'?'Link selected wallet':'Connect MetaMask'}</button>{owner&&<button className="text-link" disabled={busy} onClick={()=>void readBalances().catch(e=>setMessage(fundingError(e)))}>Refresh balances</button>}{owner&&!correctChain&&<button className="btn btn-secondary" disabled={busy} onClick={()=>void connect()}>Switch to Monad testnet</button>}</div>
    </section>
    <ol className="funding-steps">
      <li className={monReady?'done':''}><div className="funding-step-head"><h2><span className="funding-step-index" aria-hidden="true">1</span>Get test MON</h2><span className={monReady?'status':'status status-attention'}>{monReady?'Done':'Needed'}</span></div>{monReady&&<p className="funding-ready">You have test MON for network fees.</p>}<p>MON pays the small network fee. Use the MetaMask address shown above.</p>{network?.starterMon&&owner&&balances&&balances.mon<100_000_000_000_000_000n&&starter&&<p role="status" className="field-help">{starter.note??(starter.status==='sent'?(balances.mon===0n?`Flurbo sent you ${network.starterMon} test MON for network fees. It arrives within a minute; your balance updates automatically.`:'Your free test MON has been used. Use the Monad faucet for more.'):starter.status==='exhausted'?"Today's free test MON has run out. Use the Monad faucet, or try again tomorrow.":'')}</p>}<div className="funding-actions">{network?.starterMon&&owner&&balances&&balances.mon<100_000_000_000_000_000n&&starter?.status==='available'&&<button className="btn btn-primary" disabled={busy} onClick={()=>void requestStarterMon()}>Send me {network.starterMon} test MON</button>}<a className="btn btn-secondary" href={TESTNET.monFaucet} target="_blank" rel="noreferrer">Open MON faucet <ArrowUpRight aria-hidden="true" strokeWidth={1.75}/></a>{owner&&<button className="text-link" onClick={()=>void navigator.clipboard.writeText(owner).then(()=>setMessage('MetaMask address copied.')).catch(()=>setMessage('Copy the MetaMask address shown above.'))}>Copy wallet address</button>}</div></li>
      <li className={ausdReady?'done':''}><div className="funding-step-head"><h2><span className="funding-step-index" aria-hidden="true">2</span>Get test AUSD</h2><span className={ausdReady?'status':'status status-attention'}>{ausdReady?'Done':'Needed'}</span></div>{ausdReady&&<p className="funding-ready">Your wallet has test AUSD. You can review a prediction or top up below.</p>}<p>{network?.flurboFaucet?'Request 50 AUSD, once every 24 hours per wallet.':'Request test tokens from the AUSD faucet.'}</p>
        {empty&&<p role="status">The test AUSD dispenser needs a refill. Please try again later.</p>}
        {cooldown&&<p>Next request: {new Date(Number(balances!.nextClaim)*1000).toLocaleString()}.</p>}
        <div className="funding-actions"><button className="btn btn-primary btn-lg" disabled={busy||!!pending||uncertain||!owner||!correctChain||!balances||balances.mon===0n||!!empty||!!cooldown} onClick={()=>void requestFunds()}>Request test AUSD</button></div>
        {blockedReason&&<p className="field-help">{blockedReason}</p>}
      </li>
    </ol>
    {pending&&<div className="funding-actions"><a className="text-link" href={`${TESTNET.explorer}/tx/${pending.hash}`} target="_blank" rel="noreferrer">View faucet transaction <ArrowUpRight aria-hidden="true" strokeWidth={1.75}/></a><button className="btn btn-secondary" disabled={checking} onClick={()=>void checkStatus()}>Check status</button></div>}
    {message&&<p role="status" className="state-inline">{message}</p>}
    {uncertain&&<button className="btn btn-secondary" onClick={()=>{setUncertain(false);setMessage('Refresh balances before requesting again.');}}>I checked MetaMask activity</button>}
    {!expanded&&<Link href="/markets" className="text-link">Back to markets</Link>}
  </div>;
  return expanded?content:<details className="workspace-funding"><summary>Get test funds</summary>{content}</details>;
}
