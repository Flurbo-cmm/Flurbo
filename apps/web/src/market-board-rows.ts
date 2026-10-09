import {marketStatus,type HybridMarket,type HybridMarketSummary,type MarketGroup,type MarketSnapshot,type OracleMarket,type OracleMarketSummary} from './market-directory.ts';
import {marketQuestion} from './showcase-copy.ts';
import {categorize,type BoardQuery,type CategorySlug} from './market-categories.ts';

export type BoardKind='pilot'|'oracle'|'hybrid';
export type SnapshotRow={key:string;groupKey:string;groupLabel:string;category:CategorySlug;kind:BoardKind;path:string;kindLabel:string;question:string;closesAt:number;status:string;prices:{yes:string|null;no:string|null}|null;priceAt:number|null;combinable:boolean;linkedCount:number;payoutNote:string};
export type BoardRow=SnapshotRow&{href:(yes?:boolean)=>string};

// Pilot links default to Yes and only carry ?answer=no; oracle and hybrid links name the answer when one is given.
export function rowHref(kind:BoardKind,path:string,yes?:boolean){
  if(kind==='pilot')return yes===false?`${path}?answer=no`:path;
  return yes===undefined?path:`${path}?answer=${yes?'yes':'no'}`;
}
export const toSnapshotRow=(row:BoardRow):SnapshotRow=>{const copy:Partial<BoardRow>={...row};delete copy.href;return copy as SnapshotRow;};
export const rowFromSnapshot=(row:SnapshotRow):BoardRow=>({...row,href:(yes?:boolean)=>rowHref(row.kind,row.path,yes)});

const kindLabel=(value:MarketSnapshot)=>value.manifest.publication.mode==='rehearsal'?'Practice':value.manifest.publication.mode==='ethereum-activity'?'Ethereum':'Ecosystem';
const poolCounts=(markets:{pool:string}[])=>markets.reduce<Record<string,number>>((counts,m)=>{const key=m.pool.toLowerCase();counts[key]=(counts[key]||0)+1;return counts;},{});

export function buildBoardRows({groups,data,oracleMarkets,oracleData,hybridMarkets,hybridData,now}:{groups:MarketGroup[];data:Record<string,MarketSnapshot>;oracleMarkets:OracleMarket[];oracleData:Record<string,OracleMarketSummary>;hybridMarkets:HybridMarket[];hybridData:Record<string,HybridMarketSummary>;now:number}):BoardRow[]{
  const oracleCount=poolCounts(oracleMarkets),hybridCount=poolCounts(hybridMarkets);
  const rows:SnapshotRow[]=[
    ...groups.flatMap(group=>{
      const value=data[group.namespace];if(!value)return [];
      const events=value.manifest.publication.draft.events,category=categorize({pool:value.manifest.pool,kind:'pilot',mode:value.manifest.publication.mode});
      return events.map((event,index):SnapshotRow=>{
        const quote=value.prices.find(p=>p.event===index);
        return {key:group.namespace+event.id,groupKey:group.namespace,groupLabel:group.label,category,kind:'pilot',path:`/markets/${group.namespace}/${index}`,kindLabel:kindLabel(value),question:marketQuestion(event),closesAt:group.closesAt,status:marketStatus(value,now/1000),prices:quote?{yes:quote.yes,no:quote.no}:null,priceAt:value.snapshot.timestamp,combinable:events.length>1,linkedCount:events.length,payoutNote:'Results available. Collect eligible payouts in Portfolio.'};
      });
    }),
    ...oracleMarkets.map((m):SnapshotRow=>{const value=oracleData[m.id],closed=now/1000>=m.closesAt,count=oracleCount[m.pool.toLowerCase()];
      return {key:`oracle:${m.id}`,groupKey:`oracle:${m.pool.toLowerCase()}`,groupLabel:m.poolTitle,category:categorize({pool:m.pool,kind:'oracle'}),kind:'oracle',path:`/markets/oracle/${m.id}`,kindLabel:'Reality.eth + Kleros',question:m.question,closesAt:m.closesAt,status:value?.resolved?'Settled':closed?'Closed':value?.funded===false?'Unavailable':'Open',prices:value?.prices??null,priceAt:value?.marketNow??null,combinable:count>1,linkedCount:count,payoutNote:'Results available. Open this market to collect eligible payouts.'};
    }),
    ...hybridMarkets.map((m):SnapshotRow=>{const value=hybridData[m.id],closed=now/1000>=m.closesAt,count=hybridCount[m.pool.toLowerCase()];
      return {key:`hybrid:${m.id}`,groupKey:`hybrid:${m.pool.toLowerCase()}`,groupLabel:m.poolTitle,category:categorize({pool:m.pool,kind:'hybrid'}),kind:'hybrid',path:`/markets/hybrid/${m.pool}/${m.eventIndex}`,kindLabel:m.route==='mechanical'?'Source verified, Kleros challenge':'Reality.eth + Kleros',question:m.question,closesAt:m.closesAt,status:value?.resolved?'Settled':closed?'Closed':value?.funded===false?'Unavailable':'Open',prices:value?.prices??null,priceAt:value?.marketNow??null,combinable:count>1,linkedCount:count,payoutNote:'Results available. Open this market to collect eligible payouts.'};
    }),
  ];
  return rows.map(rowFromSnapshot);
}

const STATUS_LABEL={open:'Open',closed:'Closed',settled:'Settled',all:'All'} as const;
const rank=(status:string)=>status==='Open'?0:status==='Closed'?1:2;

// Watchlist shows pinned markets in any status; every other category applies the status filter.
export function filterBoardRows<R extends SnapshotRow>(rows:R[],query:BoardQuery,watchlist:ReadonlySet<string>):R[]{
  const status=STATUS_LABEL[query.status],search=query.q.toLowerCase();
  return rows.filter(r=>(query.category==='watchlist'?watchlist.has(r.key):(query.category==='all'||r.category===query.category)&&(status==='All'||r.status===status))&&r.question.toLowerCase().includes(search)).sort((a,b)=>{
    const difference=rank(a.status)-rank(b.status);if(difference)return difference;
    return query.sort==='name'?a.question.localeCompare(b.question):a.closesAt-b.closesAt;
  });
}
