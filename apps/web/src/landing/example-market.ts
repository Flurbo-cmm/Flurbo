// Illustrative numbers for the landing example. The proof links point at a real, live pool.
export const EXAMPLE={
  a:'Exchange supports the upgrade',
  b:'Upgrade goes live',
  pA:0.40,
  pB:0.30,
  pAB:0.22,
  proofPool:'0x0fc7a9634f52DD5bF91c252587f912d5e121d528',
  proofQuestionTx:'0xcdd6ab390a4ef93ae12f32ee1ddb0b27b6adc979d5bb2775236913a982107862',
} as const;
export type Assumption='none'|'yes'|'no';

export function jointCells(e:typeof EXAMPLE=EXAMPLE){
  return {yy:e.pAB,yn:e.pA-e.pAB,ny:e.pB-e.pAB,nn:1-e.pA-e.pB+e.pAB};
}

export function conditionalA(assume:Assumption,e:typeof EXAMPLE=EXAMPLE){
  if(assume==='yes')return e.pAB/e.pB;
  if(assume==='no')return (e.pA-e.pAB)/(1-e.pB);
  return e.pA;
}
