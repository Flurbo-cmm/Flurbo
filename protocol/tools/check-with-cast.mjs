// Cross-checks fixtures/calldata.json against Foundry's `cast` (an implementation independent of viem).
// Offline; needs `cast` on PATH.   node protocol/tools/check-with-cast.mjs
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const fixture = JSON.parse(await readFile(new URL('../fixtures/calldata.json', import.meta.url), 'utf8'));
const cast = (...args) => execFileSync('cast', args, { encoding: 'utf8' }).trim();
const signatures = {
  buy: 'buy(uint32,uint256,uint128,uint128,uint256)', sell: 'sell(uint32,uint256,uint128,uint128,uint256)', redeem: 'redeem(uint32,uint256,uint128)',
  quoteBuy: 'quoteBuy(uint32,uint256,uint128)', quoteSell: 'quoteSell(uint32,uint256,uint128)', holdings: 'holdings(address,uint32,uint256)',
  payoutFraction: 'payoutFraction(uint32,uint256)', approve: 'approve(address,uint256)', allowance: 'allowance(address,address)', balanceOf: 'balanceOf(address)',
};
let failures = 0, checked = 0;
for (const call of fixture.calls) {
  const signature = signatures[call.function] ?? `${call.function}()`;
  const data = cast('calldata', signature, ...call.args.map(String));
  checked++;
  if (data.toLowerCase() !== call.data.toLowerCase()) { failures++; console.error(`calldata differs: ${call.function} ${call.args.join(',')}`); }
}
for (const m of fixture.messages) {
  const signature = cast('wallet', 'sign', '--private-key', m.privateKey, m.message);
  checked++;
  if (signature.toLowerCase() !== m.signature.toLowerCase()) { failures++; console.error('message signature differs'); }
}
for (const s of fixture.signing) {
  const t = s.transaction;
  const raw = cast('mktx', '--private-key', s.privateKey, '--chain', String(t.chainId), '--nonce', String(t.nonce), '--gas-limit', t.gas,
    '--gas-price', t.maxFeePerGas, '--priority-gas-price', t.maxPriorityFeePerGas, '--value', '0', t.to, s.transaction.data);
  checked++;
  if (raw.toLowerCase() !== s.raw.toLowerCase()) { failures++; console.error(`signed transaction differs: ${s.note}`); }
}
console.log(`${checked} checked, ${failures} differ`);
process.exit(failures ? 1 : 0);
