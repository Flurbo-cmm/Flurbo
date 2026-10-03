import {createHash} from 'node:crypto';

export class CapacityError extends Error {
  constructor(retryAfter = 60) { super('Request capacity reached. Retry after the cooldown.'); this.status=429; this.code='RATE_LIMITED'; this.retryAfter=Math.max(1,Math.ceil(retryAfter)); }
}
const hash = value => createHash('sha256').update(value).digest('hex');
const increment = "local n=redis.call('INCRBY',KEYS[1],ARGV[2]); if n==tonumber(ARGV[2]) then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return n";

// Separate buckets, shared through Redis on hosted servers. Caller identities must
// come from verified authentication, never a request body or forwarded IP header.
export function requestLimits({command,now=Date.now}={}) {
  const local=new Map();
  function localTake(key,limit,cost=1) {
    const minute=Math.floor(now()/60000), id=key+':'+minute;
    for(const [k,v] of local)if(v.minute!==minute)local.delete(k);
    if(!local.has(id)&&local.size>=4096)throw new CapacityError(60-now()/1000%60);
    const value=(local.get(id)?.value||0)+cost;local.set(id,{value,minute});
    if(value>limit)throw new CapacityError(60-now()/1000%60);
  }
  async function take(key,limit,cost=1) {
    if(!command)return localTake(key,limit,cost);
    const minute=Math.floor(now()/60000);
    const value=Number(await command('EVAL',increment,1,'flurbo:capacity:v1:'+hash(key)+':'+minute,'120',String(cost)));
    if(!Number.isSafeInteger(value)||value<1)throw Error('Capacity storage unavailable');
    if(value>limit)throw new CapacityError(60-now()/1000%60);
  }
  return {take,localTake};
}

// INCR-with-expiry counter kept in this process, for rate windows that do not need to be shared (one server).
export function memoryWindow(now = Date.now) {
  const counts = new Map();
  return async (key, seconds) => {
    const t = now();
    if (counts.size >= 10_000) for (const [k, v] of counts) if (v.until <= t) counts.delete(k);
    const entry = counts.get(key);
    if (!entry || entry.until <= t) { counts.set(key, { n: 1, until: t + seconds * 1000 }); return 1; }
    return ++entry.n;
  };
}

export const expensivePath = path => /\/(?:rpc|analytics|claim-analytics|thesis|thesis-analytics|what-if|quote|prepare|positions|history|redemptions|account|status|markets|performance)(?:\/|$)/.test(path);
