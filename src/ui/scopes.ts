import type { Domain } from '../sim/core';
import { si } from '../sim/units';

export interface ScopeTrace {
  label: string;
  unit: string;
  domain: Domain;
  min?: number;
  hwKey?: string;
}

interface Series {
  t: number[];
  v: number[];
}

export interface ScopeColors {
  ground: string;
  line: string;
  text2: string;
  text3: string;
  ink: string;
  domain: Record<Domain, string>;
  domainText: Record<Domain, string>;
}

/** Stacked strip charts sharing one rolling time axis. */
export class Scopes {
  window = 10;
  private traces: ScopeTrace[] = [];
  private series: Series[] = [];
  private hw = new Map<string, Series>();
  private dpr = 1;

  constructor(private readonly canvas: HTMLCanvasElement) {}

  setTraces(traces: ScopeTrace[]): void {
    this.traces = traces;
    this.clear();
  }

  clear(): void {
    this.series = this.traces.map(() => ({ t: [], v: [] }));
    this.hw.clear();
  }

  push(t: number, values: number[]): void {
    values.forEach((v, i) => {
      const s = this.series[i];
      s.t.push(t);
      s.v.push(v);
    });
    this.trim(t);
  }

  /** Measured samples drawn dashed on the strip whose label matches. */
  pushHardware(key: string, t: number, value: number): void {
    const s = this.hw.get(key) ?? { t: [], v: [] };
    s.t.push(t);
    s.v.push(value);
    this.hw.set(key, s);
  }

  private trim(now: number): void {
    const cut = now - this.window * 1.05;
    for (const s of [...this.series, ...this.hw.values()]) {
      let k = 0;
      while (k < s.t.length && s.t[k] < cut) k++;
      if (k > 0) { s.t.splice(0, k); s.v.splice(0, k); }
    }
  }

  draw(now: number, c: ScopeColors): void {
    const cssW = this.canvas.clientWidth;
    const cssH = this.canvas.clientHeight;
    if (cssW === 0 || cssH === 0) return;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = Math.round(cssW * this.dpr), H = Math.round(cssH * this.dpr);
    if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; }
    const g = this.canvas.getContext('2d')!;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, cssW, cssH);

    const n = Math.max(1, this.traces.length);
    const left = 44, right = 8, axisH = 18, gap = 8;
    const stripH = (cssH - axisH - gap * (n - 1)) / n;
    const plotW = cssW - left - right;
    const t1 = Math.max(now, this.window);
    const t0 = t1 - this.window;
    const xOf = (t: number) => left + ((t - t0) / this.window) * plotW;

    g.font = '11px "IBM Plex Sans", system-ui, sans-serif';
    this.traces.forEach((tr, i) => {
      const top = i * (stripH + gap);
      const s = this.series[i];
      const hwS = this.hw.get(tr.label);
      let lo = tr.min ?? Infinity, hi = -Infinity;
      for (const v of s.v) { if (v < lo) lo = v; if (v > hi) hi = v; }
      if (hwS) for (const v of hwS.v) { if (v < lo) lo = v; if (v > hi) hi = v; }
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) { lo = 0; hi = 1; }
      if (hi - lo < 1e-12) { const pad = Math.abs(hi) * 0.1 || 1; lo -= tr.min === undefined ? pad : 0; hi += pad; }
      const span = hi - lo;
      hi += span * 0.12;
      if (tr.min === undefined) lo -= span * 0.08;
      const yOf = (v: number) => top + stripH - ((v - lo) / (hi - lo)) * stripH;

      g.fillStyle = c.ground;
      g.fillRect(left, top, plotW, stripH);
      g.strokeStyle = c.line;
      g.lineWidth = 1;
      g.strokeRect(left + 0.5, top + 0.5, plotW - 1, stripH - 1);
      g.beginPath();
      for (let tt = Math.ceil(t0 / 2) * 2; tt <= t1; tt += 2) {
        const x = Math.round(xOf(tt)) + 0.5;
        g.moveTo(x, top); g.lineTo(x, top + stripH);
      }
      if (lo < 0 && hi > 0) { const y = Math.round(yOf(0)) + 0.5; g.moveTo(left, y); g.lineTo(left + plotW, y); }
      g.stroke();

      g.fillStyle = c.text3;
      g.textAlign = 'right';
      g.font = '9.5px "IBM Plex Mono", ui-monospace, monospace';
      g.fillText(short(hi), left - 6, top + 9);
      g.fillText(short(lo), left - 6, top + stripH - 1);

      g.save();
      g.beginPath();
      g.rect(left, top, plotW, stripH);
      g.clip();
      if (hwS && hwS.t.length > 1) {
        g.strokeStyle = c.ink;
        g.setLineDash([4, 3]);
        g.lineWidth = 1.4;
        g.beginPath();
        hwS.t.forEach((t, k) => { const x = xOf(t), y = yOf(hwS.v[k]); if (k === 0) g.moveTo(x, y); else g.lineTo(x, y); });
        g.stroke();
        g.setLineDash([]);
      }
      g.strokeStyle = c.domain[tr.domain];
      g.lineWidth = 1.6;
      g.lineJoin = 'round';
      g.beginPath();
      s.t.forEach((t, k) => { const x = xOf(t), y = yOf(s.v[k]); if (k === 0) g.moveTo(x, y); else g.lineTo(x, y); });
      g.stroke();
      if (s.t.length) {
        g.fillStyle = c.domain[tr.domain];
        g.beginPath();
        g.arc(xOf(s.t[s.t.length - 1]), yOf(s.v[s.v.length - 1]), 3, 0, Math.PI * 2);
        g.fill();
      }
      g.restore();

      const label = `${tr.label}${hwS ? '  ·  dashed: device' : ''}`;
      const last = s.v.length ? s.v[s.v.length - 1] : NaN;
      const value = Number.isFinite(last) ? si(last, tr.unit) : '—';
      g.font = '11px "IBM Plex Sans", system-ui, sans-serif';
      const lw = g.measureText(label).width;
      g.font = '600 12px "IBM Plex Mono", ui-monospace, monospace';
      const vw = g.measureText(value).width;
      g.fillStyle = c.ground;
      g.fillRect(left + 3, top + 3, lw + 10, 16);
      g.fillRect(left + plotW - vw - 15, top + 3, vw + 10, 16);
      g.textAlign = 'left';
      g.font = '11px "IBM Plex Sans", system-ui, sans-serif';
      g.fillStyle = c.text2;
      g.fillText(label, left + 8, top + 14);
      g.textAlign = 'right';
      g.font = '600 12px "IBM Plex Mono", ui-monospace, monospace';
      g.fillStyle = c.domainText[tr.domain];
      g.fillText(value, left + plotW - 10, top + 15);
    });

    g.fillStyle = c.text3;
    g.font = '10px "IBM Plex Mono", ui-monospace, monospace';
    g.textAlign = 'center';
    for (let tt = Math.ceil(t0 / 2) * 2; tt <= t1 + 1e-9; tt += 2) {
      g.fillText(`${tt.toFixed(0)} s`, Math.min(Math.max(xOf(tt), left + 10), left + plotW - 12), cssH - 4);
    }
  }
}

function short(v: number): string {
  const a = Math.abs(v);
  if (a >= 1000) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  if (a >= 1) return v.toFixed(2);
  if (a === 0) return '0';
  return v.toPrecision(2);
}
