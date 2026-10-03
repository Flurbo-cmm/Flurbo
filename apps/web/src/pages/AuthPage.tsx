import { ArrowLeft, ArrowUpRight, Copy, LogOut } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useLocation } from "wouter";
import { useAuth } from "../auth/context";
import { takeReturnPath } from "../return-path";
import './auth.css';

type AuthMode = "login" | "signup" | "account";

export default function AuthPage({ mode }: { mode: AuthMode }) {
  const { controller, state, policy } = useAuth();
  const [, navigate] = useLocation();
  const [name, setName] = useState("Flurbo account");
  const [allowNew, setAllowNew] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");
  const destination = useRef<string | null>(null);
  const isLogin = mode !== "signup";
  const active = !!state.address;
  // One destination per visit: the page a signed-out visitor opened, otherwise the account page.
  const next = () => (destination.current ??= takeReturnPath() ?? '/access');
  useEffect(() => { if (active && !state.busy) navigate(next()); }, [active, state.busy, navigate]);
  const localHref = policy.localUrl ? new URL(isLogin ? "/login" : "/signup", policy.localUrl).href : undefined;

  async function authenticate(chooseAnother = false) {
    const succeeded = await controller.authenticate(isLogin ? "login" : "signup", name, chooseAnother, allowNew);
    if (succeeded) navigate(next());
  }
  function submit(event: FormEvent) { event.preventDefault(); void authenticate(); }
  async function copyAddress() {
    if (!state.address) return;
    try { await navigator.clipboard.writeText(state.address); setCopyStatus("Address copied."); }
    catch { setCopyStatus("Copy was unavailable. You can select the address above."); }
  }

  return (
    <main id="main" tabIndex={-1} className="page page-form auth-page">
      <Link href="/" className="link-back auth-back"><ArrowLeft size={16} strokeWidth={1.75} /> Back to flurbo</Link>
      {!isLogin && !active && <ol className="auth-steps" aria-label="Preview access steps">
        <li aria-current="step"><span>1</span>Create account</li><li><span>2</span>Request access</li><li><span>3</span>Approval</li>
      </ol>}
      <header className="auth-heading">
        <h1>{active ? "A familiar way in." : isLogin ? "Your view. Your account." : "Create your Flurbo account."}</h1>
        <p className="lead">{active ? "Your passkey opens the same account each time. Keep access to it through your password manager."
          : isLogin ? "Use your saved Flurbo passkey to return to your account."
          : "Start with a passkey. Your device or password manager handles the sign-in, without another password to remember."}</p>
      </header>
      {policy.local && <p className="callout callout-attention">Local test account only. This passkey will not work on flurbo.singu.online. Do not send real funds to this account.</p>}
      {active ? <section className="auth-body" aria-label="Signed in with Mera">
        <h2 className="auth-subtitle">Account created.</h2>
        <p>Your account is ready. Checking your testnet access.</p>
        <div className="auth-address"><span className="field-label">Mera account address</span><code className="address">{state.address}</code>
          <button type="button" className="text-link auth-copy" onClick={() => void copyAddress()}><Copy size={15} strokeWidth={1.75} /> Copy address</button></div>
        <p className="field-help" role="status">{copyStatus}</p>
        <p className="muted">Your login stays available for seven days. Connect MetaMask to trade; this account address is only for sign-in.</p>
        <button type="button" className="btn btn-secondary btn-lg btn-block" onClick={() => { controller.signOut("You are signed out. Your passkey stays in your password manager."); navigate("/login"); }}><LogOut size={16} strokeWidth={1.75} /> Sign out</button>
        <Link href="/#the-idea" className="text-link">Explore Flurbo <ArrowUpRight size={15} strokeWidth={1.75} /></Link>
      </section> : <section className="auth-body" aria-label={isLogin ? "Sign in with your passkey" : "Create a passkey account"}>
        <p className="muted">{isLogin ? "Confirm with your device's screen lock, fingerprint, or password manager."
          : "Your passkey creates an account address. Keep the passkey available in your password manager so you can return on another device."}</p>
        {!policy.rpId ? <div className="callout" role="status"><p>{policy.reason}</p>{localHref && <a className="btn btn-primary btn-lg btn-block" href={localHref}>Continue on localhost <ArrowUpRight size={16} strokeWidth={1.75} /></a>}</div>
        : <form onSubmit={submit} className="auth-form stack" aria-busy={state.busy}>
          {!isLogin && <>
            <div className="field">
              <label htmlFor="passkey-name">Passkey name</label>
              <input id="passkey-name" name="passkey-name" type="text" autoComplete="off" maxLength={48} value={name} onChange={event => setName(event.target.value)} disabled={state.busy} aria-describedby="passkey-name-help" />
              <p id="passkey-name-help" className="field-help">A label in your password manager, not a public username.</p>
            </div>
            {state.remembered && <label className="check-row"><input type="checkbox" checked={allowNew} onChange={event => setAllowNew(event.target.checked)} disabled={state.busy} /><span>A passkey is remembered here. Create a separate account with a new address.</span></label>}
            <p className="callout callout-attention">Losing this passkey means losing this Flurbo account. There is no password reset, and your email cannot restore access. Save it in a password manager that syncs across your devices.</p>
          </>}
          <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={state.busy || (!isLogin && state.remembered && !allowNew)}>
            {state.busy ? "Waiting for your passkey..." : isLogin ? "Sign in with a passkey" : "Create a passkey"}
          </button>
          {state.busy && <span className="progress-line" aria-hidden="true" />}
          <div className="cluster">
            {isLogin && state.remembered && <button type="button" className="text-link" disabled={state.busy} onClick={() => void authenticate(true)}>Choose another passkey</button>}
            {state.busy && <button type="button" className="text-link" onClick={() => controller.signOut("Sign-in cancelled here. Dismiss any remaining device prompt before trying again.")}>Cancel</button>}
          </div>
        </form>}
        {state.error && <p className="callout callout-danger" role="alert">{state.error}</p>}
        <p className="small muted">Your Mera passkey is your Flurbo login. Testnet access requires approval. Once approved, connect MetaMask to trade.</p>
        <p className="auth-switch">{isLogin ? "New to Flurbo?" : "Already have a passkey?"} <Link href={isLogin ? "/signup" : "/login"} className="text-link">{isLogin ? "Create an account" : "Sign in"}</Link></p>
        <p className="small muted">Some devices ask you to confirm twice during setup. A compatible passkey provider is required. <a href="https://mera.category.xyz/authenticator-support/" target="_blank" rel="noreferrer">Check device support</a>.</p>
      </section>}
      {state.notice && <p className="field-help" role="status">{state.notice}</p>}
    </main>
  );
}
