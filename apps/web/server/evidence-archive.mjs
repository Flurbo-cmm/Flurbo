import { keccak256, stringToHex } from 'viem';
import { evidenceURI } from '../shared/pilot.mjs';

export function evidenceArchive(command, origin, now=()=>Date.now()) {
  const key=hash=>`flurbo:pilot:evidence:v1:${hash}`;
  return {
    async put(input,login,draftHash) {
      if(!input || typeof input!=='object' || Array.isArray(input) || Object.keys(input).some(k=>!['eventId','outcome','statement','sourceURL','attachment'].includes(k))
        || typeof input.eventId!=='string' || input.eventId.length>96 || ![1,2,3].includes(input.outcome)
        || typeof input.statement!=='string' || input.statement.trim().length<20 || input.statement.length>8000
        || !evidenceURI(input.sourceURL) || typeof input.attachment!=='string' || input.attachment.length>12000) throw new Error('Provide bounded public evidence');
      const body=JSON.stringify({schema:'flurbo.pilot-evidence.v1',draftHash,uploader:login,eventId:input.eventId,outcome:input.outcome,
        statement:input.statement,sourceURL:input.sourceURL,attachment:input.attachment});
      const hash=keccak256(stringToHex(body));
      if(await command('GET',key(hash))===body) return {hash,uri:`${origin}/api/pilot/evidence/${hash}`,body};
      // Durable account and service caps bound new uploads across restarts. Reusing identical evidence is free.
      const hour=Math.floor(now()/3_600_000);
      const quota="local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],7200) end; return n";
      const accountCount=Number(await command('EVAL',quota,1,`flurbo:pilot:evidence-quota:${hour}:${login}`));
      if(!Number.isSafeInteger(accountCount)||accountCount<1||accountCount>20) throw new Error('Evidence upload limit reached. Reuse stored evidence or retry next hour.');
      const serviceCount=Number(await command('EVAL',quota,1,`flurbo:pilot:evidence-quota:${hour}:all`));
      if(!Number.isSafeInteger(serviceCount)||serviceCount<1||serviceCount>200) throw new Error('Evidence service upload limit reached. Retry next hour.');
      // No expiry: evidence must outlive a login, deployment and settlement. Immutable by content hash.
      await command('SET',key(hash),body,'NX');
      if(await command('GET',key(hash))!==body) throw new Error('Evidence persistence failed');
      return {hash,uri:`${origin}/api/pilot/evidence/${hash}`,body};
    },
    async get(hash) {
      if(!/^0x[0-9a-f]{64}$/.test(hash)) throw new Error('Invalid evidence hash');
      const body=await command('GET',key(hash));
      if(typeof body!=='string' || keccak256(stringToHex(body))!==hash) throw new Error('Evidence unavailable');
      return body;
    },
  };
}
