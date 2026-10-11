// Public Mera account identity. MetaMask addresses never grant operator access.
export const DEFAULT_TESTING_OPERATOR = '0x2ff9ca4cb64fa82915144e8d9cf6a6ceddaa35e3';
export const testingPages = new Set(['/account', '/events', '/metrics']);
export function isTestingOperator(session, account = DEFAULT_TESTING_OPERATOR) {
  return !!account && session?.method === 'passkey' && session.address?.toLowerCase() === account.toLowerCase();
}
