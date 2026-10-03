import net from 'node:net';
import {randomBytes} from 'node:crypto';

// A minimal RESP client so the agent store's tests can run against a real, isolated Redis-compatible
// server (FLURBO_TEST_REDIS_URL=redis://127.0.0.1:6390/0). Replies are shaped like Upstash REST results:
// bulk strings as strings, integers as numbers, nil as null, arrays as arrays. Not a test file.
type Reply={value:any;end:number;error?:boolean}|null;
function parse(buf:Buffer,i:number):Reply{
  if(i>=buf.length)return null;
  const lineEnd=buf.indexOf('\r\n',i);if(lineEnd<0)return null;
  const type=String.fromCharCode(buf[i]),line=buf.toString('utf8',i+1,lineEnd),next=lineEnd+2;
  if(type==='+')return {value:line,end:next};
  if(type==='-')return {value:line,end:next,error:true};
  if(type===':')return {value:Number(line),end:next};
  if(type==='$'){const n=Number(line);if(n<0)return {value:null,end:next};if(buf.length<next+n+2)return null;return {value:buf.toString('utf8',next,next+n),end:next+n+2};}
  if(type==='*'){const n=Number(line);if(n<0)return {value:null,end:next};const out=[];let at=next;
    for(let k=0;k<n;k++){const r=parse(buf,at);if(!r)return null;out.push(r.value);at=r.end;}return {value:out,end:at};}
  throw new Error('Unexpected RESP reply');
}
const clients=new Map<string,(...args:any[])=>Promise<any>>();
export function respCommand(url:string){
  if(clients.has(url))return clients.get(url)!;
  const u=new URL(url);
  if(u.protocol!=='redis:'||!['127.0.0.1','localhost','::1','[::1]'].includes(u.hostname))throw new Error('Tests use only a local, isolated Redis (redis://127.0.0.1:port/db).');
  const socket=net.createConnection({host:u.hostname.replace(/^\[|\]$/g,''),port:Number(u.port||6379)});socket.unref();
  let buffer=Buffer.alloc(0);const queue:{resolve:(v:any)=>void;reject:(e:Error)=>void}[]=[];
  socket.on('data',d=>{buffer=Buffer.concat([buffer,d]);
    for(;;){const r=parse(buffer,0);if(!r)break;buffer=buffer.subarray(r.end);const q=queue.shift()!;if(r.error)q.reject(new Error(r.value));else q.resolve(r.value);}});
  socket.on('error',e=>{while(queue.length)queue.shift()!.reject(e);});
  const command=(...args:any[])=>new Promise<any>((resolve,reject)=>{
    const parts=args.map(a=>Buffer.from(String(a)));
    queue.push({resolve,reject});
    socket.write(Buffer.concat([Buffer.from(`*${parts.length}\r\n`),...parts.flatMap(p=>[Buffer.from(`$${p.length}\r\n`),p,Buffer.from('\r\n')])]));
  });
  const db=u.pathname.slice(1);if(db)void command('SELECT',db);
  clients.set(url,command);
  return command;
}

// Every key a test writes gets a fresh random namespace, so each setup() starts empty and runs never
// collide. Only key positions are rewritten; values and scripts are passed through unchanged.
export function namespacedRedis(url:string){
  const raw=respCommand(url),ns=`flurbo-test:${randomBytes(6).toString('hex')}:`;
  const keyPositions=(op:string,a:any[])=>op==='EVAL'?a.slice(2,2+Number(a[1])).map((_,i)=>2+i):op==='MGET'?a.map((_,i)=>i):['GET','SET','DEL','TTL','EXISTS','GETDEL','SMEMBERS'].includes(op)?[0]:null;
  const command=async(op:string,...a:any[])=>{
    const positions=keyPositions(op,a);if(!positions)throw new Error('Unexpected command '+op);
    const args=[...a];for(const i of positions)args[i]=ns+args[i];
    return raw(op,...args);
  };
  const keys=async()=>{const out:string[]=[];let cursor='0';
    do{const [next,batch]=await raw('SCAN',cursor,'MATCH',ns+'*','COUNT',1000);cursor=next;out.push(...batch.map((k:string)=>k.slice(ns.length)));}while(cursor!=='0');return out;};
  return {command,keys,get:(k:string)=>raw('GET',ns+k) as Promise<string|null>,set:async(k:string,v:string)=>{await raw('SET',ns+k,v);},del:async(k:string)=>{await raw('DEL',ns+k);}};
}
