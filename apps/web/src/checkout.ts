import type { PilotNamespace } from './pilot';
import {CLAIM_RULES, type ClaimRule} from '../shared/claims.mjs';

export type CheckoutDraft={event:number;yes:boolean;legs:number[];answers:Record<number,boolean>;rule?:ClaimRule;quantity:string;side:'buy'|'sell'|'redeem';walletKind?:'mera'|'browser';binding?:{pool:string;rulesHash:string}};
const key=(namespace:PilotNamespace,login:string)=>`flurbo.checkout.v1:${namespace}:${login.toLowerCase()}`;
function valid(value:unknown):value is CheckoutDraft {
  const d=value as CheckoutDraft;
  return !!d&&Number.isInteger(d.event)&&d.event>=0&&d.event<4&&typeof d.yes==='boolean'
    &&Array.isArray(d.legs)&&d.legs.length>0&&d.legs.length<=3&&new Set(d.legs).size===d.legs.length&&d.legs.includes(d.event)
    &&d.legs.every(i=>Number.isInteger(i)&&i>=0&&i<4)&&!!d.answers&&typeof d.answers==='object'
    &&Object.entries(d.answers).every(([i,v])=>/^[0-3]$/.test(i)&&typeof v==='boolean')
    &&(d.rule===undefined||CLAIM_RULES.includes(d.rule))&&(d.rule!=='AT_LEAST_TWO'||d.legs.length>=2)
    &&typeof d.quantity==='string'&&d.quantity.length<=40
    &&(d.binding===undefined||!!d.binding&&/^0x[0-9a-f]{40}$/i.test(d.binding.pool)&&/^0x[0-9a-f]{64}$/i.test(d.binding.rulesHash))
    &&['buy','sell','redeem'].includes(d.side)&&[undefined,'mera','browser'].includes(d.walletKind);
}
// Only form fields are restored. A saved draft never grants signing permission.
export function readCheckout(namespace:PilotNamespace,login:string):CheckoutDraft|null {
  const raw=localStorage.getItem(key(namespace,login));
  if(!raw)return null;
  if(raw.length>2000)throw new Error('Saved prediction is invalid.');
  const draft:unknown=JSON.parse(raw);
  if(!valid(draft))throw new Error('Saved prediction is invalid.');
  return draft;
}
export function saveCheckout(namespace:PilotNamespace,login:string,draft:CheckoutDraft){
  if(!valid(draft))throw new Error('Invalid prediction draft.');
  localStorage.setItem(key(namespace,login),JSON.stringify(draft));
}
// Pages opened earlier in this page load (a full reload clears it). A combined draft is recovery for a reload;
// returning to a market from elsewhere in the app starts from the single answer the user chose, unless a
// transaction for the combination may still be pending or it came from the thesis explorer (bound to a pool).
const visited=new Set<string>();
export function markCheckoutVisited(namespace:PilotNamespace,login:string){visited.add(key(namespace,login));}
export function restorableCheckout(namespace:PilotNamespace,login:string,draft:CheckoutDraft|null,hasPending:boolean):CheckoutDraft|null{
  if(!draft)return null;
  return draft.legs.length>1&&!draft.binding&&!hasPending&&visited.has(key(namespace,login))?null:draft;
}
export function clearCheckout(namespace:PilotNamespace,login:string){localStorage.removeItem(key(namespace,login));}
export function assertCheckoutBinding(draft:CheckoutDraft|null,manifest:{pool:string;rulesHash:string}){
  if(draft?.binding&&(draft.binding.pool.toLowerCase()!==manifest.pool.toLowerCase()||draft.binding.rulesHash.toLowerCase()!==manifest.rulesHash.toLowerCase()))throw Error('This thesis belongs to a different market version. Return to the explorer and compare again.');
}
