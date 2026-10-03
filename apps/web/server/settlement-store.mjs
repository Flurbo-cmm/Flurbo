import { createHash, randomUUID } from 'node:crypto';

export const leaseScript = `-- flurbo-monitor-lease
if redis.call('GET',KEYS[1]) ~= ARGV[1] then return 0 end
if ARGV[2] == 'release' then return redis.call('DEL',KEYS[1]) end
redis.call('PEXPIRE',KEYS[1],300000)
if ARGV[2] == 'save' then redis.call('SET',KEYS[2],ARGV[3]) end
return 1`;

export async function settlementLease(command, identity) {
  const key = `flurbo:monitor:v1:${createHash('sha256').update(identity).digest('hex')}`;
  const token = randomUUID();
  if (await command('SET', `${key}:lock`, token, 'NX', 'PX', 300000) !== 'OK') throw new Error('Monitor already running');
  const act = async (operation, state = '') => {
    if (await command('EVAL', leaseScript, 2, `${key}:lock`, `${key}:state`, token, operation, state) !== 1) throw new Error('Monitor lease lost');
  };
  return {
    load: async () => { const raw = await command('GET', `${key}:state`); return raw === null ? null : JSON.parse(raw); },
    save: state => act('save', JSON.stringify(state)), renew: () => act('renew'), release: () => act('release'),
  };
}
