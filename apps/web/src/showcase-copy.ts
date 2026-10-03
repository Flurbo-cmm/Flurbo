// Display copy only. Never rewrite published manifests or settlement evidence.
type EventCopyInput={id:string;question:string};
const copy:Record<string,{original:string;title:string;description:string}>={
  'ethereum-fullness':{original:'Will Ethereum fill at least 75% of a block?',title:'Will the selected Ethereum block be at least 75% full?',description:'Yes if the block uses at least 75% of its gas limit. Fullness measures gas used, not the number of transactions.'},
  'ethereum-transactions':{original:'Will Ethereum include at least 150 transactions?',title:'Will the selected Ethereum block contain at least 150 transactions?',description:'Yes if this single block contains 150 or more transactions.'},
  'ethereum-fees':{original:'Will Ethereum’s base fee rise?',title:'Will the selected Ethereum block have a higher base fee than the previous block?',description:'Yes if its base fee per gas is higher than its immediate parent’s. An equal or lower base fee means No; tips are not included.'},
  'ethereum-blobs':{original:'Will Ethereum carry at least 3 blobs?',title:'Will the selected Ethereum block include at least 3 data blobs?',description:'Yes if the block uses at least 393,216 blob gas, equivalent to 3 data blobs. Blobs carry extra data, often used by rollups.'},
};
export function showcaseCopy(event:EventCopyInput){
  const value=copy[event.id];
  return value?.original===event.question?value:null;
}
export function marketQuestion(event:EventCopyInput){return showcaseCopy(event)?.title??event.question;}
