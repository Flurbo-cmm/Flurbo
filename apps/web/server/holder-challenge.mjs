import {randomBytes} from 'node:crypto';
import {privateKeyToAccount} from 'viem/accounts';
import {eligibilityTypedData} from '../shared/holder-challenge.mjs';

export function holderAuthorizer({env=process.env,now=()=>Math.floor(Date.now()/1000)}={}){
  return async function authorize(service,login,wallets,input){
    const policy=service.manifest.challengePolicy;
    if(!policy||policy.version!=='account-holders-v1')throw Error('Holder-only resolver required');
    if(!wallets.includes(input.owner?.toLowerCase())||!wallets.includes(input.stake?.holder?.toLowerCase()))throw Error('Both wallets must be linked to this Flurbo account.');
    const {eligible,snapshot,challengeUntil}=await service.challengeStake(input.event,input.stake);
    if(!eligible)throw Error('No qualifying shares in the linked wallet.');
    const key=env.FLURBO_CHALLENGE_AUTHORIZATION_KEY;
    if(!/^0x[0-9a-f]{64}$/i.test(key||''))throw Error('Challenge authorization is unavailable.');
    const signer=privateKeyToAccount(key);
    if(signer.address.toLowerCase()!==policy.authority)throw Error('Challenge authorization is unavailable.');
    const deadline=Math.min(snapshot.timestamp+90,now()+90,Number(challengeUntil));
    if(deadline<=now()+10)throw Error('Not enough time remains to authorize this challenge.');
    // The commitment is randomized per authorization. Membership itself remains in the signed-in account service.
    const authorization={accountCommitment:'0x'+randomBytes(32).toString('hex'),challenger:input.owner.toLowerCase(),
      holder:input.stake.holder.toLowerCase(),scope:input.stake.scope,mask:input.stake.mask,wrapped:input.stake.wrapped,
      nonce:BigInt('0x'+randomBytes(32).toString('hex')).toString(),deadline:String(deadline)};
    const signature=await signer.signTypedData(eligibilityTypedData(service.manifest.resolver,input,authorization));
    return {authorization,signature};
  };
}
