import { css } from '../ui/dom';

export interface Series {
  label: string;
  points: [number, number][];
  /** line (default), points (markers only), bars (vertical bars from the axis), or step. */
  style?: 'line' | 'points' | 'bars' | 'dashed';
  /** Token name for the color, e.g. '--d-fluid'. Defaults cycle through the domain colors. */
  color?: string;
}

export interface Mark {
  x?: number;
  y?: number;
  label: string;
}

export interface Chart {
  title: string;
  xLabel: string;
  yLabel: string;
  series: Series[];
  xLog?: boolean;
  yLog?: boolean;
  marks?: Mark[];
  /** Fixed axis ranges; otherwise they follow the data. */
  xRange?: [number, number];
  yRange?: [number, number];
}

const CYCLE = ['--d-electrical', '--d-thermal', '--d-rotational', '--d-fluid', '--d-translational', '--warn'];

function niceTicks(lo: number, hi: number, n = 5): number[] {
  const span = hi - lo || Math.abs(hi) || 1;
  const raw = span / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= n) ?? 10 * mag;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return out;
}

function fmt(v: number): string {
  const a = Math.abs(v);
  if (a === 0) return '0';
  if (a >= 1e5 || a < 1e-3) return v.toExponential(0).replace('e+', 'e');
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1).replace(/\.0$/, '');
  return v.toPrecision(2).replace(/\.?0+$/, '');
}

/** Draws a chart into a canvas sized by CSS, crisp at any pixel ratio, in the current theme. */
export function drawChart(canvas: HTMLCanvasElement, c: Chart): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = canvas.clientWidth || 520, H = canvas.clientHeight || 240;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  const g = canvas.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  const ink = css('--ink') || '#E3EBF3', text2 = css('--text-2') || '#9AA', line = css('--line') || '#333';
  const mono = '11px "IBM Plex Mono", ui-monospace, monospace';

  const pts = c.series.flatMap((s) => s.points).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y) && (!c.xLog || x > 0) && (!c.yLog || y > 0));
  const tx = (v: number) => (c.xLog ? Math.log10(v) : v);
  const ty = (v: number) => (c.yLog ? Math.log10(v) : v);
  let [x0, x1] = c.xRange ? [tx(c.xRange[0]), tx(c.xRange[1])] : [Math.min(...pts.map((p) => tx(p[0]))), Math.max(...pts.map((p) => tx(p[0])))];
  let [y0, y1] = c.yRange ? [ty(c.yRange[0]), ty(c.yRange[1])] : [Math.min(...pts.map((p) => ty(p[1]))), Math.max(...pts.map((p) => ty(p[1])))];
  for (const m of c.marks ?? []) { if (m.y !== undefined && !c.yRange) { y0 = Math.min(y0, ty(m.y)); y1 = Math.max(y1, ty(m.y)); } }
  if (c.series.some((s) => s.style === 'bars') && !c.yLog) y0 = Math.min(0, y0);
  if (!Number.isFinite(x0)) { x0 = 0; x1 = 1; }
  if (!Number.isFinite(y0)) { y0 = 0; y1 = 1; }
  if (x1 - x0 < 1e-12) { x0 -= 0.5; x1 += 0.5; }
  if (y1 - y0 < 1e-12) { y0 -= Math.abs(y0) * 0.1 + 0.5; y1 += Math.abs(y1) * 0.1 + 0.5; }
  if (!c.yRange) { const pad = (y1 - y0) * 0.08; y1 += pad; if (y0 !== 0) y0 -= pad; }

  const L = 58, R = 14, T = 26, B = 40;
  const px = (v: number) => L + ((tx(v) - x0) / (x1 - x0)) * (W - L - R);
  const py = (v: number) => T + (1 - (ty(v) - y0) / (y1 - y0)) * (H - T - B);

  g.font = '600 12px "IBM Plex Sans", system-ui, sans-serif';
  g.fillStyle = ink;
  g.textBaseline = 'top';
  g.fillText(c.title, L, 6);

  g.font = mono;
  g.strokeStyle = line;
  g.lineWidth = 1;
  g.fillStyle = text2;
  const xt = c.xLog ? decades(x0, x1) : niceTicks(x0, x1, Math.max(3, Math.floor((W - L - R) / 80)));
  const yt = c.yLog ? decades(y0, y1) : niceTicks(y0, y1, 4);
  g.textAlign = 'center';
  for (const v of xt) {
    const X = L + ((v - x0) / (x1 - x0)) * (W - L - R);
    g.beginPath(); g.moveTo(X, T); g.lineTo(X, H - B); g.stroke();
    g.fillText(c.xLog ? fmt(10 ** v) : fmt(v), X, H - B + 5);
  }
  g.textAlign = 'right';
  g.textBaseline = 'middle';
  for (const v of yt) {
    const Y = T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
    g.beginPath(); g.moveTo(L, Y); g.lineTo(W - R, Y); g.stroke();
    g.fillText(c.yLog ? fmt(10 ** v) : fmt(v), L - 6, Y);
  }
  g.textAlign = 'center';
  g.textBaseline = 'bottom';
  g.fillText(c.xLabel, L + (W - L - R) / 2, H - 2);
  g.save();
  g.translate(12, T + (H - T - B) / 2);
  g.rotate(-Math.PI / 2);
  g.textBaseline = 'top';
  g.fillText(c.yLabel, 0, -6);
  g.restore();

  g.save();
  g.beginPath(); g.rect(L, T, W - L - R, H - T - B); g.clip();
  c.series.forEach((s, i) => {
    const col = css(s.color ?? CYCLE[i % CYCLE.length]) || '#74A6FF';
    g.strokeStyle = col; g.fillStyle = col; g.lineWidth = 2;
    const ok = s.points.filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y) && (!c.xLog || x > 0) && (!c.yLog || y > 0));
    if (s.style === 'points') {
      for (const [x, y] of ok) { g.beginPath(); g.arc(px(x), py(y), 3.2, 0, Math.PI * 2); g.fill(); }
    } else if (s.style === 'bars') {
      const w = Math.max(3, ((W - L - R) / Math.max(1, ok.length)) * 0.55);
      const base = py(c.yLog ? 10 ** y0 : Math.max(y0, 0));
      for (const [x, y] of ok) g.fillRect(px(x) - w / 2, Math.min(base, py(y)), w, Math.abs(base - py(y)));
    } else {
      g.setLineDash(s.style === 'dashed' ? [6, 4] : []);
      g.beginPath();
      ok.forEach(([x, y], k) => (k ? g.lineTo(px(x), py(y)) : g.moveTo(px(x), py(y))));
      g.stroke();
      g.setLineDash([]);
    }
  });
  g.strokeStyle = ink; g.fillStyle = ink; g.lineWidth = 1;
  g.setLineDash([4, 4]);
  g.textBaseline = 'bottom';
  g.textAlign = 'left';
  for (const m of c.marks ?? []) {
    if (m.y !== undefined) { const Y = py(m.y); g.beginPath(); g.moveTo(L, Y); g.lineTo(W - R, Y); g.stroke(); g.fillText(m.label, L + 6, Y - 2); }
    if (m.x !== undefined) { const X = px(m.x); g.beginPath(); g.moveTo(X, T); g.lineTo(X, H - B); g.stroke(); g.fillText(m.label, X + 4, T + 14); }
  }
  g.setLineDash([]);
  g.restore();

  // Legend, top right.
  g.font = mono;
  g.textAlign = 'right';
  g.textBaseline = 'middle';
  let lx = W - R;
  for (let i = c.series.length - 1; i >= 0; i--) {
    const s = c.series[i];
    const w = g.measureText(s.label).width;
    g.fillStyle = text2;
    g.fillText(s.label, lx, 12);
    g.fillStyle = css(s.color ?? CYCLE[i % CYCLE.length]) || '#74A6FF';
    g.fillRect(lx - w - 14, 10, 10, 4);
    lx -= w + 26;
    if (lx < L + 160) break;
  }
}

function decades(lo: number, hi: number): number[] {
  const out: number[] = [];
  for (let d = Math.ceil(lo); d <= Math.floor(hi); d++) out.push(d);
  if (out.length < 2) return niceTicks(lo, hi, 3);
  return out;
}

/** Chart data as CSV: one x column per series. */
export function chartCsv(c: Chart): string {
  const rows: string[] = [];
  const max = Math.max(...c.series.map((s) => s.points.length));
  rows.push(c.series.map((s) => `"${s.label} · ${c.xLabel}","${s.label} · ${c.yLabel}"`).join(','));
  for (let i = 0; i < max; i++) rows.push(c.series.map((s) => (s.points[i] ? `${s.points[i][0]},${s.points[i][1]}` : ',')).join(','));
  return rows.join('\n');
}
