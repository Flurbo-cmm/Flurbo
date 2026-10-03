import {useEffect, useState} from 'react';
import {useAuth} from './context';

export function useTestingAccess() {
  const {state} = useAuth();
  const [allowedAccount, setAllowedAccount] = useState('');
  useEffect(() => {
    const abort = new AbortController();
    setAllowedAccount('');
    if (state.address) void fetch('/api/account/access', {credentials:'same-origin', cache:'no-store', signal:AbortSignal.any([abort.signal,AbortSignal.timeout(10000)])})
      .then(async response => { if (!response.ok) throw Error(); return response.json(); })
      .then(value => { if (!abort.signal.aborted && value.testingTools === true) setAllowedAccount(state.address!); })
      .catch(() => {});
    return () => abort.abort();
  }, [state.address]);
  return !!state.address && allowedAccount === state.address;
}
