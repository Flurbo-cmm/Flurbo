import { useEffect, useState } from 'react';
import TransactionSheet from './ui/TransactionSheet';
import { WALLET_SIGNATURE_EVENT } from '../sheet-state';

// Shown on every page while MetaMask is asked to sign the wallet link message. It cannot be dismissed and closes
// when the wallet answers, whichever flow asked.
export default function WalletLinkSheet() {
  const [wallet, setWallet] = useState<string | null>(null);
  useEffect(() => {
    const onSignature = (event: Event) => {
      const detail = (event as CustomEvent<{ wallet: string; open: boolean }>).detail;
      setWallet(detail?.open ? detail.wallet : null);
    };
    window.addEventListener(WALLET_SIGNATURE_EVENT, onSignature);
    return () => window.removeEventListener(WALLET_SIGNATURE_EVENT, onSignature);
  }, []);
  return (
    <TransactionSheet phase={wallet ? 'wallet' : 'closed'} title="Link this wallet">
      <p>Sign the message in MetaMask to link <span className="num">{wallet ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}` : ''}</span> to your Flurbo account.</p>
      <p className="market-caption">Signing proves you control this wallet. It is not a transaction: nothing is sent and there is no network fee.</p>
    </TransactionSheet>
  );
}
