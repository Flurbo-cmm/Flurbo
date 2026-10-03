import type {MarketGroup} from './market-directory';

// Markets still open for trading first (soonest close first), then closed ones, most recent first: the holdings
// people are acting on load before old pools.
export function portfolioOrder(groups:MarketGroup[],now=Date.now()/1000):MarketGroup[]{
  const open=(g:MarketGroup)=>g.closesAt>now;
  return [...groups].sort((a,b)=>open(a)!==open(b)?(open(a)?-1:1):open(a)?a.closesAt-b.closesAt:b.closesAt-a.closesAt);
}
