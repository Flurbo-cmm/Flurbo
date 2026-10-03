// Pure state machine for the branded contour loader. The loader never runs on a
// timer of its own: it only moves forward when the host reports real readiness.
export type LoaderPhase = 'idle' | 'armed' | 'entering' | 'waiting' | 'resolving' | 'complete' | 'exiting' | 'failed';

export const TIMING = {
  showDelay: 200,
  enter: 700,
  resolve: 240,
  resolveFast: 180,
  fastWindow: 300,
  dot: 60,
  settle: 100,
  hold: 40,
  minVisible: 400,
  slowNotice: 8000,
  maxWait: 25000,
  exit: 180,
  watchdog: 1500,
  reducedFadeIn: 120,
  reducedFadeOut: 160,
  reducedMinVisible: 200,
} as const;

export type LoaderState = {
  phase: LoaderPhase;
  label: string;
  stage: number;
  stages: number;
  error: string | null;
  slow: boolean;
  shownAt: number | null;
  readyAt: number | null;
  fast: boolean;
};

export type LoaderEvent =
  | { type: 'open'; label: string; stage: number; stages: number }
  | { type: 'progress'; label: string; stage: number; stages: number }
  | { type: 'show'; now: number }
  | { type: 'entered' }
  | { type: 'ready'; now: number }
  | { type: 'resolved' }
  | { type: 'held' }
  | { type: 'exited' }
  | { type: 'fail'; error: string; now: number }
  | { type: 'slow' }
  | { type: 'retry' }
  | { type: 'abandon' }
  | { type: 'reset' };

export const initialLoaderState: LoaderState = {
  phase: 'idle', label: '', stage: 0, stages: 1, error: null, slow: false, shownAt: null, readyAt: null, fast: false,
};

const visible = (phase: LoaderPhase) => phase === 'entering' || phase === 'waiting' || phase === 'resolving' || phase === 'complete' || phase === 'failed';

export function reduceLoader(state: LoaderState, event: LoaderEvent): LoaderState {
  switch (event.type) {
    case 'open':
      if (state.phase !== 'idle') return { ...state, label: event.label, stage: event.stage, stages: event.stages };
      return { ...initialLoaderState, phase: 'armed', label: event.label, stage: event.stage, stages: event.stages };
    case 'progress':
      if (state.phase === 'idle' || (state.label === event.label && state.stage === event.stage && state.stages === event.stages)) return state;
      return { ...state, label: event.label, stage: event.stage, stages: event.stages };
    case 'show':
      return state.phase === 'armed' ? { ...state, phase: 'entering', shownAt: event.now } : state;
    case 'entered':
      return state.phase === 'entering' ? { ...state, phase: 'waiting' } : state;
    case 'ready':
      if (state.phase === 'armed') return { ...initialLoaderState };
      if (state.phase === 'entering' || state.phase === 'waiting') {
        const fast = state.shownAt !== null && event.now - state.shownAt < TIMING.fastWindow;
        return { ...state, phase: 'resolving', readyAt: event.now, fast, error: null };
      }
      return state;
    case 'resolved':
      return state.phase === 'resolving' ? { ...state, phase: 'complete' } : state;
    case 'held':
      return state.phase === 'complete' ? { ...state, phase: 'exiting' } : state;
    case 'exited':
      return state.phase === 'exiting' ? { ...initialLoaderState } : state;
    case 'fail':
      if (state.phase === 'idle' || state.phase === 'exiting' || state.phase === 'resolving' || state.phase === 'complete') return state;
      return { ...state, phase: 'failed', error: event.error, shownAt: state.shownAt ?? event.now };
    case 'slow':
      return state.phase === 'waiting' || state.phase === 'entering' ? { ...state, slow: true } : state;
    case 'retry':
      return state.phase === 'failed' ? { ...state, phase: 'waiting', error: null, slow: false } : state;
    case 'abandon':
      if (state.phase === 'armed') return { ...initialLoaderState };
      return visible(state.phase) ? { ...state, phase: 'exiting' } : state;
    case 'reset':
      return { ...initialLoaderState };
  }
}

/** How long the completed logo must hold so the loader is visible for at least the minimum. */
export function holdFor(state: LoaderState, now: number, reduced: boolean): number {
  const min = reduced ? TIMING.reducedMinVisible : TIMING.minVisible;
  const shown = state.shownAt ?? now;
  const settle = reduced ? 0 : TIMING.dot + TIMING.settle + TIMING.hold;
  return Math.max(settle, min - (now - shown));
}

export function resolveDuration(state: LoaderState, reduced: boolean): number {
  if (reduced) return 0;
  return state.fast ? TIMING.resolveFast : TIMING.resolve;
}
