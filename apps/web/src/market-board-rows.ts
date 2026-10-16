import {type HybridMarket,type HybridMarketSummary,type OracleMarket,type OracleMarketSummary} from './market-directory.ts';
import {categorize,type BoardQuery,type CategorySlug} from './market-categories.ts';

export type BoardKind='oracle'|'hybrid';
export type SnapshotRow={key:string;groupKey:string;groupLabel:string;category:CategorySlug;kind:BoardKind;path:string;kindLabel:string;question:string;closesAt:number;status:string;prices:{yes:string|null;no:string|null}|null;priceAt:number|null;combinable:boolean;linkedCount:number;payoutNote:string};
export type BoardRow=SnapshotRow&{href:(yes?:boolean)=>string};

// Links name the answer when one is given.
export function rowHref(path:string,yes?:boolean){
  return yes===undefined?path:`${path}?answer=${yes?'yes':'no'}`;
}
export const toSnapshotRow=(row:BoardRow):SnapshotRow=>{const copy:Partial<BoardRow>={...row};delete copy.href;return copy as SnapshotRow;};
export const rowFromSnapshot=(row:SnapshotRow):BoardRow=>({...row,href:(yes?:boolean)=>rowHref(row.path,yes)});

const poolCounts=(markets:{pool:string}[])=>markets.reduce<Record<string,number>>((counts,m)=>{const key=m.pool.toLowerCase();counts[key]=(counts[key]||0)+1;return counts;},{});

export function buildBoardRows({oracleMarkets,oracleData,hybridMarkets,hybridData,now}:{oracleMarkets:OracleMarket[];oracleData:Record<string,OracleMarketSummary>;hybridMarkets:HybridMarket[];hybridData:Record<string,HybridMarketSummary>;now:number}):BoardRow[]{
  const oracleCount=poolCounts(oracleMarkets),hybridCount=poolCounts(hybridMarkets);
  const rows:SnapshotRow[]=[
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

export type PoolGroup={groupKey:string;label:string;count:number;open:number;closesAt:number;webPath:string|null;rows:SnapshotRow[]};

// One entry per pool, soonest close first. Only a hybrid pool with several questions has a connections page.
export function groupRows(rows:SnapshotRow[]):PoolGroup[]{
  const groups=new Map<string,PoolGroup>();
  for(const row of rows){
    const group=groups.get(row.groupKey)??{groupKey:row.groupKey,label:row.groupLabel,count:0,open:0,closesAt:row.closesAt,webPath:null,rows:[]};
    group.count+=1;group.rows.push(row);
    if(row.status==='Open')group.open+=1;
    group.closesAt=Math.min(group.closesAt,row.closesAt);
    groups.set(row.groupKey,group);
  }
  return [...groups.values()].map(group=>({...group,webPath:group.rows[0].kind==='hybrid'&&group.count>1?group.rows[0].path.replace(/\/\d+$/,'/web'):null})).sort((a,b)=>a.closesAt-b.closesAt||a.label.localeCompare(b.label));
}
