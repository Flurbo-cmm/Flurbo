import { useEffect, useRef, useState } from 'react';
import { motion, type Transition } from 'framer-motion';
import { CONTOUR_PATHS, IVORY, LIME, LOCKUP } from '../components/BrandLogo';
import { TIMING, type LoaderPhase } from './load-gate';

// Presentational only: it imports nothing from application state. Both contour
// systems are the exact logo paths, so when they coincide the frame IS the logo.
const MARK_CENTER = { x: 30.91, y: 32.71 }; // path units, measured bounding-box centre
const MARK_HEIGHT = 54; // path units including stroke
const LOCKUP_MARK_CENTER = { x: 18 + 1.9 * MARK_CENTER.x, y: 18 + 1.9 * MARK_CENTER.y };
const LOCKUP_CENTER = { x: 20 + 416 / 2, y: 27 + 125 / 2 };
const EASE_OUT = [0.22, 1, 0.36, 1] as const;
const EASE_IN = [0.55, 0, 1, 0.45] as const;
const EASE_IN_OUT = [0.65, 0, 0.35, 1] as const;

export type ContourLoaderProps = {
  phase: LoaderPhase;
  label: string;
  stage: number;
  stages: number;
  error: string | null;
  slow: boolean;
  fast: boolean;
  reduced: boolean;
  onRetry(): void;
  onLeave(): void;
};

function useViewport() {
  const [size, setSize] = useState(() => ({ w: typeof window === 'undefined' ? 1440 : window.innerWidth, h: typeof window === 'undefined' ? 900 : window.innerHeight }));
  useEffect(() => {
    const update = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', update);
    window.visualViewport?.addEventListener('resize', update);
    return () => { window.removeEventListener('resize', update); window.visualViewport?.removeEventListener('resize', update); };
  }, []);
  return size;
}

function Rings({ scale }: { scale: number }) {
  return <g transform={`scale(${scale}) translate(${-MARK_CENTER.x} ${-MARK_CENTER.y})`} fill="none" stroke={IVORY} strokeLinecap="round" strokeLinejoin="round">
    {CONTOUR_PATHS.map((p) => <path key={p.d} strokeWidth={p.width} d={p.d} />)}
  </g>;
}

export default function ContourLoader({ phase, label, stage, stages, error, slow, fast, reduced, onRetry, onLeave }: ContourLoaderProps) {
  const { w, h } = useViewport();
  const retryRef = useRef<HTMLButtonElement>(null);
  const [hidden, setHidden] = useState(() => typeof document !== 'undefined' && document.hidden);
  useEffect(() => {
    const update = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  useEffect(() => { if (phase === 'failed') retryRef.current?.focus(); }, [phase]);

  const markPx = w < 640 ? 56 : 88;
  const s = markPx / MARK_HEIGHT; // path units to pixels
  const k = s / 1.9; // lockup units to pixels
  const exiting = phase === 'exiting';
  const lockupShown = phase === 'complete' || exiting || reduced;
  const instant = hidden;
  const t = (seconds: number, ease: Transition['ease'] = EASE_OUT, delay = 0): Transition => (instant ? { duration: 0 } : { duration: seconds, ease, delay });

  const side = (dir: -1 | 1) => {
    const base = { rotate: dir < 0 ? -14 : 11, y: dir < 0 ? 16 : -16 };
    const offscreen = { x: dir * (w / 2 + 1.6 * markPx), y: base.y, rotate: base.rotate, scaleX: 1.6, scaleY: 1.6, opacity: 0 };
    const entered = { x: dir * w * (w < 640 ? 0.18 : 0.24), y: base.y, rotate: base.rotate, scaleX: 1.6, scaleY: 1.6, opacity: 0.9 };
    const drifting = { x: dir * w * (w < 640 ? 0.1 : 0.12), y: base.y * 0.6, rotate: dir < 0 ? -8 : 6, scaleX: 1.56, scaleY: 1.46, opacity: 0.86 };
    const merged = { x: 0, y: 0, rotate: 0, scaleX: 1, scaleY: 1, opacity: 1 };
    let target: Record<string, number> = offscreen;
    let transition: Transition = t(0);
    if (phase === 'entering') { target = entered; transition = { ...t(TIMING.enter / 1000), opacity: t(0.24) }; }
    else if (phase === 'waiting') { target = drifting; transition = t(6, EASE_OUT); }
    else if (phase === 'resolving') { target = merged; transition = t((fast ? TIMING.resolveFast : TIMING.resolve) / 1000, EASE_IN); }
    else if (phase === 'failed') { target = { opacity: 0.25 }; transition = t(0.2); }
    else if (lockupShown) { target = { ...merged, opacity: 0 }; transition = { duration: 0 }; }
    return { initial: offscreen, animate: target, transition };
  };
  const left = side(-1);
  const right = side(1);
  const dx = (LOCKUP_MARK_CENTER.x - LOCKUP_CENTER.x) * k;
  const dy = (LOCKUP_MARK_CENTER.y - LOCKUP_CENTER.y) * k;
  const placed = reduced || exiting;

  return (
    <div className="contour-loader" data-phase={phase} role="status" aria-live="polite" aria-busy={phase !== 'failed'}>
      <span className="sr-only">{phase === 'failed' ? '' : label}</span>
      <motion.div className="contour-panel contour-panel-left" aria-hidden="true"
        initial={{ opacity: 0, x: '0%' }}
        animate={exiting ? { opacity: 1, x: reduced ? '0%' : '-100%' } : { opacity: 1, x: '0%' }}
        transition={exiting ? (reduced ? t(TIMING.reducedFadeOut / 1000) : t(TIMING.exit / 1000, EASE_IN_OUT)) : t((reduced ? TIMING.reducedFadeIn : 160) / 1000)} />
      <motion.div className="contour-panel contour-panel-right" aria-hidden="true"
        initial={{ opacity: 0, x: '0%' }}
        animate={exiting ? { opacity: 1, x: reduced ? '0%' : '100%' } : { opacity: 1, x: '0%' }}
        transition={exiting ? (reduced ? t(TIMING.reducedFadeOut / 1000) : t(TIMING.exit / 1000, EASE_IN_OUT)) : t((reduced ? TIMING.reducedFadeIn : 160) / 1000)} />
      <motion.svg className="contour-stage" viewBox={`0 0 ${w} ${h}`} width={w} height={h} aria-hidden="true" focusable="false"
        initial={{ opacity: 0 }}
        animate={{ opacity: exiting ? 0 : 1 }}
        transition={exiting ? t(0.12) : t(reduced ? TIMING.reducedFadeIn / 1000 : 0.16)}>
        <g transform={`translate(${w / 2} ${h / 2})`}>
          {!reduced && <>
            <motion.g style={{ transformBox: 'fill-box', transformOrigin: 'center' }} {...left}><Rings scale={s} /></motion.g>
            <motion.g style={{ transformBox: 'fill-box', transformOrigin: 'center' }} {...right}><Rings scale={s} /></motion.g>
          </>}
          {lockupShown && <motion.g initial={{ x: placed ? dx : 0, y: placed ? dy : 0 }} animate={{ x: dx, y: dy }}
            transition={placed ? { duration: 0 } : t(TIMING.settle / 1000, EASE_IN_OUT, TIMING.dot / 1000)}>
            <g transform={`translate(${-LOCKUP_MARK_CENTER.x * k} ${-LOCKUP_MARK_CENTER.y * k}) scale(${k})`}>
              <g transform={LOCKUP.markTransform} fill="none" stroke={IVORY} strokeLinecap="round" strokeLinejoin="round">
                {CONTOUR_PATHS.map((p) => <path key={p.d} strokeWidth={p.width} d={p.d} />)}
              </g>
              <motion.circle cx={LOCKUP.dot.cx} cy={LOCKUP.dot.cy} r={LOCKUP.dot.r} fill={LIME}
                style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
                initial={placed ? { opacity: 1, scale: 1 } : { opacity: 0, scale: 0.6 }} animate={{ opacity: 1, scale: 1 }}
                transition={placed ? { duration: 0 } : t(TIMING.dot / 1000)} />
              <motion.text x="170" y="111" fill={IVORY} fontFamily="Space Grotesk, Arial, sans-serif" fontSize="102" fontWeight="560" letterSpacing="-6.2"
                initial={placed ? { opacity: 1, x: 0 } : { opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }}
                transition={placed ? { duration: 0 } : t(TIMING.settle / 1000, EASE_OUT, TIMING.dot / 1000)}>flurbo</motion.text>
            </g>
          </motion.g>}
        </g>
      </motion.svg>
      {reduced && phase !== 'failed' && <div className="contour-progress" style={{ top: `calc(50% + ${Math.round(markPx * 0.9)}px)` }}>
        <span className="contour-progress-track"><span style={{ width: `${Math.max(1, Math.min(stages, stage + (phase === 'complete' || exiting ? 1 : 0))) / Math.max(1, stages) * 100}%` }} /></span>
        <span className="contour-progress-label">{label}</span>
      </div>}
      {slow && phase === 'waiting' && <p className="contour-slow" style={{ top: `calc(50% + ${Math.round(markPx * 1.1)}px)` }}>Still {label.charAt(0).toLowerCase() + label.slice(1)}. Testnet reads can take a moment.</p>}
      {phase === 'failed' && <div className="contour-failure" role="alert">
        <h2>We could not finish loading</h2>
        <p>{error || 'Something went wrong while loading.'}</p>
        <div className="contour-failure-actions">
          <button ref={retryRef} type="button" className="btn btn-inverse" onClick={onRetry}>Try again</button>
          <button type="button" className="text-link contour-leave" onClick={onLeave}>Back to Flurbo</button>
        </div>
      </div>}
    </div>
  );
}
