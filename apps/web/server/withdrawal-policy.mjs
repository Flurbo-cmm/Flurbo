// Shared by the Mera signer and relay. Only a direct, positive AUSD transfer
// from the authenticated account is allowed; no transferFrom or approval.
export function validWithdrawal({ to, data, account, cash, pool }) {
  if (typeof data !== 'string' || !/^0xa9059cbb0{24}[0-9a-f]{40}[0-9a-f]{64}$/i.test(data) ||
      !cash || to?.toLowerCase() !== cash.toLowerCase()) return false;
  const recipient = ('0x' + data.slice(34, 74)).toLowerCase();
  const amount = BigInt('0x' + data.slice(74));
  return amount > 0n && amount < (1n << 128n) &&
    !['0x' + '0'.repeat(40), account?.toLowerCase(), cash.toLowerCase(), pool?.toLowerCase()].includes(recipient);
}
