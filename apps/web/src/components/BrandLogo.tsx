// Exact geometry of public/brand/flurbo-logo.svg. Do not redraw: paths, dot and
// wordmark attributes are copied verbatim; only the viewBox is cropped to the ink.
export const CONTOUR_PATHS = [
  { d: 'M11 19C18 7 39 5 51 14c10 8 7 29-4 38-11 10-31 4-39-9-6-10-3-18 3-24Z', width: 4.5 },
  { d: 'M20 19c8-6 22-4 27 5 5 9-2 20-12 23-10 3-20-3-21-13-1-6 1-11 6-15Z', width: 4.5 },
  { d: 'M27 27c6-4 14 0 14 7-1 6-9 9-14 5-5-4-5-9 0-12Z', width: 5.5 },
] as const;
export const LOCKUP = { markTransform: 'translate(18 18) scale(1.9)', dot: { cx: 98, cy: 146, r: 4 }, viewBox: '20 27 416 125' } as const;
export const INK = '#14271d';
export const IVORY = '#f5f4ec';
export const LIME = '#d9f76d';

type BrandLogoProps = { inverse?: boolean; className?: string; title?: string };

export function ContourMark({ color = 'currentColor' }: { color?: string }) {
  return <g fill="none" stroke={color} strokeLinecap="round" strokeLinejoin="round">
    {CONTOUR_PATHS.map((p) => <path key={p.d} strokeWidth={p.width} d={p.d} />)}
  </g>;
}

export default function BrandLogo({ inverse = false, className = '', title = 'Flurbo' }: BrandLogoProps) {
  const ink = inverse ? IVORY : INK;
  return (
    <svg className={`logo ${inverse ? 'logo-inverse' : ''} ${className}`.trim()} viewBox={LOCKUP.viewBox} role="img" aria-label={title} focusable="false">
      <g transform={LOCKUP.markTransform}><ContourMark color={ink} /></g>
      <circle className="logo-joint-state" cx={LOCKUP.dot.cx} cy={LOCKUP.dot.cy} r={LOCKUP.dot.r} fill={LIME} />
      <text x="170" y="111" fill={ink} fontFamily="Space Grotesk, Arial, sans-serif" fontSize="102" fontWeight="560" letterSpacing="-6.2">flurbo</text>
    </svg>
  );
}
