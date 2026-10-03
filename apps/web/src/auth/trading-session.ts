// Connection permission belongs to MetaMask. Account ownership belongs to the
// server-verified Mera wallet links. Never infer either from a saved address.
export type TradingProvider = {
  request(input:{method:string;params?:unknown[]}):Promise<unknown>;
  on?(event:string,listener:()=>void):void;
  removeListener?(event:string,listener:()=>void):void;
};
type Links={account:string;wallets:string[]};
export type TradingConnection={owner:string;status:'checking'|'connected'|'unlinked'|'disconnected'|'unavailable';selected?:string};
export function watchTradingWallet({provider,account,links,publish,surface=window}:{
  provider:TradingProvider;account:string;links:()=>Promise<Links>;
  publish(value:TradingConnection):void;surface?:Pick<Window,'addEventListener'|'removeEventListener'>;
}){
  let version=0,stopped=false;
  const emit=publish;
  async function check(invalidate=false){
    const request=++version;
    if(invalidate)emit({owner:'',status:'checking'});
    try{
      const addresses=await provider.request({method:'eth_accounts'});
      if(stopped||request!==version)return;
      const selected=Array.isArray(addresses)&&typeof addresses[0]==='string'&&/^0x[0-9a-f]{40}$/i.test(addresses[0])?addresses[0].toLowerCase():'';
      if(!selected){emit({owner:'',status:'disconnected'});return;}
      const known=await links();
      const latest=await provider.request({method:'eth_accounts'});
      if(stopped||request!==version)return;
      if(known.account.toLowerCase()!==account.toLowerCase()||!Array.isArray(latest)||String(latest[0]).toLowerCase()!==selected){emit({owner:'',status:'unavailable'});return;}
      emit(known.wallets.some(w=>w.toLowerCase()===selected)?{owner:selected,status:'connected'}:{owner:'',selected,status:'unlinked'});
    }catch{if(!stopped&&request===version)emit({owner:'',status:'unavailable'});}
  }
  const changed=()=>void check(true),focus=()=>void check();
  const disconnect=()=>{++version;emit({owner:'',status:'disconnected'});};
  for(const event of ['accountsChanged','chainChanged','connect'])provider.on?.(event,changed);
  provider.on?.('disconnect',disconnect);
  surface.addEventListener('focus',focus);surface.addEventListener('flurbo:wallet-linked',focus);
  void check(true);
  return ()=>{stopped=true;++version;for(const event of ['accountsChanged','chainChanged','connect'])provider.removeListener?.(event,changed);provider.removeListener?.('disconnect',disconnect);surface.removeEventListener('focus',focus);surface.removeEventListener('flurbo:wallet-linked',focus);};
}
