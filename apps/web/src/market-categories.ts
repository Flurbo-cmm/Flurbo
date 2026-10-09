export type CategorySlug='all'|'watchlist'|'crypto'|'economics'|'politics'|'sports'|'tech'|'culture'|'science'|'practice'|'other';
export type BoardStatus='open'|'closed'|'settled'|'all';
export type BoardSort='closing'|'name';
export type BoardQuery={category:CategorySlug;status:BoardStatus;q:string;sort:BoardSort;page:number};

export const CATEGORY_ORDER:readonly CategorySlug[]=['all','watchlist','crypto','economics','politics','sports','tech','culture','science','practice','other'];
export const CATEGORY_LABEL:Record<CategorySlug,string>={all:'All',watchlist:'Watchlist',crypto:'Crypto',economics:'Economics',politics:'Politics',sports:'Sports',tech:'Tech',culture:'Culture',science:'Science',practice:'Practice',other:'Other'};

// Every registered pool, by lowercase address. A newly registered pool fails the category test until it is listed here.
export const CATEGORY_BY_POOL:Readonly<Record<string,CategorySlug>>={
  '0x8c931a6f799d69185ee2f2f47e46667fd0da545b':'crypto',
  '0x8301d8de76528cd2e0965b21b7e0d926c30c5932':'crypto',
  '0xb5ce32de7a8631960dd26ab46bb20524d1ff9a44':'crypto',
  '0x6da09fa753f97f7078b5a61c332262af93c89a2c':'crypto',
  '0x0fc7a9634f52dd5bf91c252587f912d5e121d528':'crypto',
};

export function categorize({pool,kind,mode}:{pool:string;kind:'pilot'|'oracle'|'hybrid';mode?:string}):CategorySlug{
  const mapped=CATEGORY_BY_POOL[pool.toLowerCase()];
  if(mapped)return mapped;
  if(kind==='pilot'&&mode==='rehearsal')return 'practice';
  if(kind==='pilot'&&mode==='ethereum-activity')return 'crypto';
  return 'other';
}

export function visibleCategories(rows:{category:CategorySlug}[],watchlistCount:number){
  const counts=new Map<CategorySlug,number>();
  for(const row of rows)counts.set(row.category,(counts.get(row.category)??0)+1);
  return CATEGORY_ORDER.flatMap(slug=>{
    const count=slug==='all'?rows.length:slug==='watchlist'?watchlistCount:counts.get(slug)??0;
    return slug==='all'||count>0?[{slug,label:CATEGORY_LABEL[slug],count}]:[];
  });
}

const DEFAULTS:BoardQuery={category:'all',status:'open',q:'',sort:'closing',page:1};
const STATUSES:readonly BoardStatus[]=['open','closed','settled','all'];
const SORTS:readonly BoardSort[]=['closing','name'];

export function readBoardQuery(search:string):BoardQuery{
  const params=new URLSearchParams(search);
  const pick=<T extends string>(name:string,allowed:readonly T[],fallback:T)=>{const value=params.get(name) as T|null;return value&&allowed.includes(value)?value:fallback;};
  const page=Number(params.get('page'));
  return {
    category:pick('category',CATEGORY_ORDER,DEFAULTS.category),
    status:pick('status',STATUSES,DEFAULTS.status),
    q:(params.get('q')??'').slice(0,120),
    sort:pick('sort',SORTS,DEFAULTS.sort),
    page:Number.isSafeInteger(page)&&page>=1?page:DEFAULTS.page,
  };
}

export function writeBoardQuery(query:BoardQuery):string{
  const params=new URLSearchParams();
  for(const key of ['category','status','q','sort','page'] as const)if(query[key]!==DEFAULTS[key])params.set(key,String(query[key]));
  const text=params.toString();
  return text?'?'+text:'';
}
