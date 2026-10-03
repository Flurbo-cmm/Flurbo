export const ACTIVITY_MODE:'ethereum-activity';
export const ACTIVITY_TITLE:'Showcase v0';
export const ACTIVITY_METRICS:string[];
export const TEST_ACTIVITY_METRICS:string[];
export function activityMetrics(draft:unknown):string[];
export function activityEvent(metric:string,target:number):{id:string;question:string;yesRule:string;noRule:string;observationStartsAt:number;observationEndsAt:number;source:{publisher:string;referenceUrl:string;recordId:string;selectionRule:string;finalityRule:string;revisionRule:string}};
export function validateActivityDraft(draft:unknown):number;
export function activityOutcome(metric:string,block:{gasUsed:bigint;gasLimit:bigint;transactions:number;baseFeePerGas:bigint;blobGasUsed:bigint},parent:{baseFeePerGas:bigint}):number;
