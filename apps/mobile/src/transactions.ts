import { checkPilotPending, pendingKeyFor, readPilotPending, submitPilot, type PilotNamespace, type PilotPending, type PilotReview } from '../../web/src/pilot';
import { rememberConfirmedClaim } from '../../web/src/pilot-claims';
import { auth, storage } from './runtime';
import { tradingProvider, externalWallet, type WalletKind } from './wallet';
import { lockOperation } from './operation-lock';
import { submitOptions, type SemanticConsent } from './semantic';

type State = { busy: boolean; pending: PilotPending | null; namespace: PilotNamespace; notice: string; revision: number };
let state: State = { busy: false, pending: null, namespace: 'pilot', notice: '', revision: 0 };
const listeners = new Set<() => void>();
const update = (patch: Partial<State>) => { state = { ...state, ...patch, revision: state.revision + 1 }; listeners.forEach(fn => fn()); };
function save(value: PilotPending | null) {
  if (value) storage.setItem(pendingKeyFor(state.namespace), JSON.stringify(value));
  else storage.removeItem(pendingKeyFor(state.namespace));
  update({ pending: value });
}
export const transactions = {
  getSnapshot: () => state,
  subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
  restore() {
    const practice = storage.keys().flatMap(key => /^flurbo\.(practice-[0-9a-f]{40})\.pending\.v1$/.exec(key)?.[1] ?? []) as PilotNamespace[];
    for (const namespace of ['pilot', ...practice] as PilotNamespace[]) {
      const pending = readPilotPending(namespace);
      if (pending) { update({ namespace, pending, notice: 'An earlier transaction needs checking. Do not buy again.' }); return; }
    }
  },
  async submit(review: PilotReview, namespace: PilotNamespace, kind: WalletKind, reviewed: () => boolean = () => true, consent: SemanticConsent = { review: null, phrase: '' }) {
    if (state.busy || state.pending) throw new Error('Check the pending transaction before another action.');
    const login = auth.getSnapshot().address;
    if (!login) throw new Error('Sign in before trading.');
    auth.checkExpiry();
    if (kind !== 'metamask') throw new Error('Use MetaMask for transactions.');
    const owner = externalWallet.getSnapshot().address;
    if (owner?.toLowerCase() !== review.requested.owner.toLowerCase()) throw new Error('Trading wallet changed. Review again.');
    const release = lockOperation();
    update({ busy: true, namespace, notice: 'Checking this exact transaction before confirmation...' });
    try {
      const current = () => reviewed() && auth.getSnapshot().address === login && externalWallet.getSnapshot().address === owner;
      await submitPilot(tradingProvider(kind, namespace), review, login, save, current, submitOptions(review, namespace, consent));
      await storage.flush();
      update({ notice: 'Submitted. Check confirmation before placing another trade.' });
    } catch (e) { update({ notice: e instanceof Error ? e.message : 'Check wallet activity before retrying.' }); throw e; }
    finally { release(); update({ busy: false }); }
  },
  async check() {
    const saved = state.pending;
    if (!saved || state.busy) return;
    update({ busy: true });
    try {
      const status = await checkPilotPending(saved);
      if (status === 'confirmed' || status === 'reverted') {
        if (status === 'confirmed') rememberConfirmedClaim(state.namespace, saved);
        save(null); await storage.flush();
        update({ notice: status === 'reverted' ? 'This transaction reverted. No trade was completed.' : saved.review.action === 'approve' ? 'Approval confirmed. Return to your prediction to confirm the purchase.' : 'Confirmed. Your portfolio can now read the updated shares.' });
        this.restore();
      } else update({ notice: status === 'pending' ? 'Still pending on Monad. Do not repeat this transaction.' : 'Included in a block. Waiting for the next block.' });
    } catch (e) { update({ notice: e instanceof Error ? e.message : 'Could not check this transaction. Try again shortly.' }); }
    finally { update({ busy: false }); }
  },
  async attachHash(hash: string) {
    if (!state.pending || state.busy || !/^0x[0-9a-f]{64}$/i.test(hash)) throw new Error('Enter the transaction hash from your wallet.');
    save({ ...state.pending, hash: hash.toLowerCase() as `0x${string}` }); await storage.flush(); await this.check();
  },
};
