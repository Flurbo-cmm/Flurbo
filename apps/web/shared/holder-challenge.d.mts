import type {Abi} from 'viem';
export const eligibilityTuple:string;
export const holderResolverAbi:Abi;
export const eligibilityTypes:any;
export function eligibilityTypedData(resolver:string,input:any,e:any):any;
export function dependsOnEvent(scope:number,mask:bigint,event:number,count:number):boolean;
export function challengeCandidates(wallets:string[],event:number,count:number,scopes:number[]):{holder:string;scope:number;mask:string;wrapped:boolean}[];
