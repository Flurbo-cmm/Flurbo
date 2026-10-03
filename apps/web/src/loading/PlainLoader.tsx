import { useEffect, useRef } from 'react';
import BrandLogo from '../components/BrandLogo';
import type { ContourLoaderProps } from './ContourLoader';

// Shown for the moment the animated loader is still downloading, or in its place if
// that download fails. Same cover, static lockup, and the same recovery actions.
export default function PlainLoader({ phase, label, error, onRetry, onLeave }: ContourLoaderProps) {
  const retryRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (phase === 'failed') retryRef.current?.focus(); }, [phase]);
  return (
    <div className="contour-loader contour-plain" data-phase={phase} role="status" aria-live="polite" aria-busy={phase !== 'failed'}>
      <span className="sr-only">{phase === 'failed' ? '' : label}</span>
      <div className="contour-panel contour-panel-left" aria-hidden="true" />
      <div className="contour-panel contour-panel-right" aria-hidden="true" />
      {phase !== 'failed' && <span className="contour-plain-logo" aria-hidden="true"><BrandLogo inverse /></span>}
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
