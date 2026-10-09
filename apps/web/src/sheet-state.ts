export type SheetPhase='closed'|'review'|'wallet'|'pending'|'done'|'failed';

// Announced around a wallet link signature so one sheet can explain it on any page.
export const WALLET_SIGNATURE_EVENT='flurbo:wallet-signature';

// Which part of a transaction flow the sheet shows, derived from the flow's own state.
export function sheetPhase({review,pending,completed,walletRequest}:{review:unknown;pending:{hash?:string|null}|null|undefined;completed:boolean|string|null|undefined;walletRequest:boolean}):SheetPhase{
  if(pending)return 'pending';
  if(walletRequest)return 'wallet';
  if(review)return 'review';
  if(completed)return 'done';
  return 'closed';
}

// While the wallet is asked, or before a transaction has a hash, closing the sheet could lose track of it.
export function canDismiss(phase:SheetPhase,hasHash:boolean){
  if(phase==='wallet')return false;
  if(phase==='pending')return hasHash;
  return true;
}
