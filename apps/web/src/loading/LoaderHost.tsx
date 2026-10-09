import { lazy, Suspense, useCallback, useEffect, useReducer, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { useReducedMotion } from 'framer-motion';
import PlainLoader from './PlainLoader';
import { activeGates, completeGates, gatesVersion, subscribeGates } from './gates';
import { holdFor, initialLoaderState, reduceLoader, resolveDuration, TIMING } from './load-gate';
import './loader.css';

// The animated loader downloads when a page first waits, so public pages never load it.
// The download starts with the show delay; a failed download falls back to the static cover.
const loadContour = () => import('./ContourLoader');
const ContourLoader = lazy(() => loadContour().catch(() => ({ default: PlainLoader })));
// Readiness must hold this long so a child page can register its own gate first.
const READY_HOLD = 60;

// Owns every timer of the branded loader. Readiness comes only from gates that
// pages register; the host adds no requests and restores scroll and focus on exit.
export default function LoaderHost({ children }: { children: ReactNode }) {
  useSyncExternalStore(subscribeGates, gatesVersion, gatesVersion);
  const [state, dispatch] = useReducer(reduceLoader, initialLoaderState);
  const reduced = !!useReducedMotion();
  const appRef = useRef<HTMLDivElement>(null);
  const gates = activeGates();
  const pending = gates.filter((gate) => gate.status === 'pending');
  const failed = gates.find((gate) => gate.status === 'error');
  const ready = gates.length > 0 && !pending.length && !failed;
  const readyRef = useRef(ready);
  readyRef.current = ready;
  const readyCount = gates.filter((gate) => gate.status === 'ready').length;
  const current = pending[pending.length - 1] || failed || gates[gates.length - 1];
  const label = current?.label || 'Loading Flurbo';
  const ids = gates.map((gate) => gate.id).join('|');
  const visible = state.phase !== 'idle' && state.phase !== 'armed';

  // Open and progress follow the registered gates. A page that reports an error
  // has its own recovery UI, so the loader steps aside and reveals it instead of
  // covering it; the loader's own failure screen is reserved for the maximum wait.
  useEffect(() => {
    if (!gates.length) return;
    if (failed) {
      completeGates(gates.map((gate) => gate.id));
      if (state.phase !== 'idle') dispatch({ type: 'abandon' });
      return;
    }
    if (state.phase === 'idle' && pending.length) {
      void loadContour().catch(() => undefined);
      dispatch({ type: 'open', label, stage: readyCount, stages: Math.max(gates.length, readyCount + 1) });
    }
    else if (state.phase !== 'idle') dispatch({ type: 'progress', label, stage: readyCount, stages: Math.max(gates.length, readyCount + (ready ? 0 : 1)) });
  }, [ids, pending.length, failed, label, readyCount, ready, gates.length, state.phase]);

  // Readiness must hold briefly so a child page can register its own gate first.
  useEffect(() => {
    if (!ready || !['armed', 'entering', 'waiting', 'failed'].includes(state.phase)) return;
    const timer = setTimeout(() => {
      if (state.phase === 'failed') dispatch({ type: 'retry' });
      dispatch({ type: 'ready', now: performance.now() });
    }, READY_HOLD);
    return () => clearTimeout(timer);
  }, [ready, state.phase]);

  // Navigating away (for example a redirect to sign in) releases the loader.
  useEffect(() => {
    if (gates.length || !['armed', 'entering', 'waiting', 'failed'].includes(state.phase)) return;
    const timer = setTimeout(() => dispatch({ type: 'abandon' }), 60);
    return () => clearTimeout(timer);
  }, [gates.length, state.phase]);

  // Phase timers.
  useEffect(() => {
    const now = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (state.phase === 'armed') {
      // A page that is already ready is only holding for child gates; showing now would cover it.
      const show = () => { if (readyRef.current) timer = setTimeout(show, READY_HOLD); else dispatch({ type: 'show', now: performance.now() }); };
      timer = setTimeout(show, TIMING.showDelay);
    }
    else if (state.phase === 'entering') timer = setTimeout(() => dispatch({ type: 'entered' }), reduced ? TIMING.reducedFadeIn : TIMING.enter);
    else if (state.phase === 'resolving') timer = setTimeout(() => dispatch({ type: 'resolved' }), resolveDuration(state, reduced));
    else if (state.phase === 'complete') {
      completeGates(ids ? ids.split('|') : []);
      timer = setTimeout(() => dispatch({ type: 'held' }), holdFor(state, now, reduced));
    } else if (state.phase === 'exiting') timer = setTimeout(() => dispatch({ type: 'exited' }), reduced ? TIMING.reducedFadeOut : TIMING.exit);
    return () => clearTimeout(timer);
    // Timers restart only on phase changes; values read here are captured at that moment.
  }, [state.phase]);

  // Slow notice and the maximum wait.
  useEffect(() => {
    if (state.phase !== 'waiting' && state.phase !== 'entering') return;
    const shown = state.shownAt ?? performance.now();
    const elapsed = performance.now() - shown;
    const slow = setTimeout(() => dispatch({ type: 'slow' }), Math.max(0, TIMING.slowNotice - elapsed));
    const limit = setTimeout(() => dispatch({ type: 'fail', error: 'This is taking longer than expected. Your connection or the testnet may be slow.', now: performance.now() }), Math.max(0, TIMING.maxWait - elapsed));
    return () => { clearTimeout(slow); clearTimeout(limit); };
  }, [state.phase, state.shownAt]);

  // Watchdog: the loader can never block the page once it is ready.
  useEffect(() => {
    if (state.readyAt === null) return;
    const timer = setTimeout(() => dispatch({ type: 'reset' }), TIMING.resolve + TIMING.minVisible + TIMING.exit + TIMING.watchdog);
    return () => clearTimeout(timer);
  }, [state.readyAt]);

  // Lock scroll and make the page inert only while the loader is visible.
  useEffect(() => {
    if (!visible) return;
    const root = document.documentElement;
    const previous = root.style.overflow;
    root.style.overflow = 'hidden';
    return () => {
      root.style.overflow = previous;
      requestAnimationFrame(() => {
        const active = document.activeElement;
        if (!active || active === document.body) document.getElementById('main')?.focus({ preventScroll: true });
        const anchor = window.location.hash ? document.getElementById(decodeURIComponent(window.location.hash.slice(1))) : null;
        anchor?.scrollIntoView();
      });
    };
  }, [visible]);

  // The reserved scrollbar gutter shows the root background; it matches the cover until the cover opens. Set from
  // here rather than with a root :has() rule, which made every layout of the page several times slower.
  const covering = visible && state.phase !== 'exiting';
  useEffect(() => {
    if (!covering) return;
    const root = document.documentElement;
    const previous = root.style.backgroundColor;
    root.style.backgroundColor = 'var(--surface-inverse)';
    return () => { root.style.backgroundColor = previous; };
  }, [covering]);

  const retry = useCallback(() => {
    const target = activeGates().find((gate) => gate.status === 'error' && gate.retry) || activeGates().find((gate) => gate.retry);
    dispatch({ type: 'retry' });
    if (target?.retry) target.retry(); else window.location.reload();
  }, []);
  const leave = useCallback(() => { window.location.assign('/'); }, []);
  const loaderProps = { phase: state.phase, label, stage: state.stage, stages: state.stages, error: state.error, slow: state.slow, fast: state.fast, reduced, onRetry: retry, onLeave: leave };

  return <>
    <div ref={appRef} className="app-root" inert={visible && state.phase !== 'exiting' ? true : undefined}>{children}</div>
    {visible && <Suspense fallback={<PlainLoader {...loaderProps} />}><ContourLoader {...loaderProps} /></Suspense>}
  </>;
}
