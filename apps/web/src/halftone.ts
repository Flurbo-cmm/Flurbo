import { CONTOUR_PATHS } from './components/BrandLogo';

// A static halftone of the logo's own contour rings: dots grow where the rings run. Drawn once on a canvas.
export type HalftoneOptions = { color: string; opacity: number; markHeight: number; cx: number; cy: number; step: number; maxRadius: number; band: number; base?: number };
const MARK_CENTER = { x: 30.91, y: 32.71 }, MARK_HEIGHT = 54;

export function drawHalftone(canvas: HTMLCanvasElement, o: HalftoneOptions) {
  const width = canvas.clientWidth, height = canvas.clientHeight;
  if (!width || !height) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
  const cols = Math.ceil(width / o.step), rows = Math.ceil(height / o.step);
  // A coarse mask, one pixel per dot: the rings stroked in widening, faint passes give a soft falloff.
  const mask = document.createElement('canvas');
  mask.width = cols; mask.height = rows;
  const mc = mask.getContext('2d'), ctx = canvas.getContext('2d');
  if (!mc || !ctx) return;
  const scale = o.markHeight / MARK_HEIGHT / o.step;
  mc.setTransform(scale, 0, 0, scale, (width * o.cx) / o.step - MARK_CENTER.x * scale, (height * o.cy) / o.step - MARK_CENTER.y * scale);
  mc.lineCap = 'round'; mc.lineJoin = 'round'; mc.strokeStyle = '#000';
  const passes = 6;
  for (let k = passes; k >= 1; k--) {
    mc.globalAlpha = 0.35;
    mc.lineWidth = ((o.band * 2 * k) / passes) / (o.markHeight / MARK_HEIGHT);
    for (const p of CONTOUR_PATHS) mc.stroke(new Path2D(p.d));
  }
  const alpha = mc.getImageData(0, 0, cols, rows).data;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = o.color; ctx.globalAlpha = o.opacity;
  ctx.beginPath();
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    const a = alpha[(y * cols + x) * 4 + 3] / 255;
    const r = Math.max(Math.pow(a, 0.9) * o.maxRadius, (o.base ?? 0) * (x / cols));
    if (r < 0.3) continue;
    const px = x * o.step + o.step / 2, py = y * o.step + o.step / 2;
    ctx.moveTo(px + r, py); ctx.arc(px, py, r, 0, Math.PI * 2);
  }
  ctx.fill();
}
