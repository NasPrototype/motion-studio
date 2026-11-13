import { Simulator } from '../sim/core';
import { SCENES } from '../sim/scenes';
import type { Chart } from './chart';
import type { SimTarget } from './types';

/*
 * Virtual test benches. Each one models the specimen or rig with the physics behind the real
 * test, adds seeded measurement scatter, and reduces the "readings" the way the standard method
 * does, so the numbers a student gets come out of the same arithmetic as in the lab.
 */

export interface BenchInput {
  key: string;
  label: string;
  unit?: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  options?: { value: number; label: string }[];
}

export interface BenchOutcome {
  results: { label: string; value: string }[];
  charts: Chart[];
  verdict?: { pass: boolean; text: string };
  notes?: string[];
  /** Headline numbers for the test log. */
  record: Record<string, string>;
}

export interface Bench {
  id: SimTarget;
  title: string;
  instrument: string;
  standards?: string[];
  summary: string;
  inputs: BenchInput[];
  run(v: Record<string, number>): BenchOutcome;
}

// ------------------------------------------------------------------ helpers

function rng(seed: number) {
  let a = (Math.floor(seed) * 2654435761) >>> 0 || 1;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gauss = () => { const u = Math.max(1e-12, next()), v = next(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  return { next, gauss };
}

const seedInput: BenchInput = { key: 'seed', label: 'Specimen / run number', value: 1, min: 1, max: 999, step: 1 };
const n = (v: number, d = 3) => (Number.isFinite(v) ? (Math.abs(v) >= 1e5 || (Math.abs(v) < 1e-3 && v !== 0) ? v.toExponential(2) : v.toFixed(d)) : '—');
const opt = (labels: string[]) => labels.map((label, value) => ({ value, label }));
const lin = (a: number, b: number, k: number) => Array.from({ length: k }, (_, i) => a + ((b - a) * i) / (k - 1));
const logspace = (a: number, b: number, k: number) => lin(Math.log10(a), Math.log10(b), k).map((x) => 10 ** x);

function linfit(pts: [number, number][]) {
  const m = pts.length;
  const sx = pts.reduce((s, p) => s + p[0], 0), sy = pts.reduce((s, p) => s + p[1], 0);
  const sxx = pts.reduce((s, p) => s + p[0] * p[0], 0), sxy = pts.reduce((s, p) => s + p[0] * p[1], 0);
  const slope = (m * sxy - sx * sy) / (m * sxx - sx * sx);
  const intercept = (sy - slope * sx) / m;
  const mean = sy / m;
  const ssr = pts.reduce((s, p) => s + (p[1] - (slope * p[0] + intercept)) ** 2, 0);
  const sst = pts.reduce((s, p) => s + (p[1] - mean) ** 2, 0);
  return { slope, intercept, r2: sst > 0 ? 1 - ssr / sst : 1 };
}

function waterViscosity(T: number): number { return 2.414e-5 * 10 ** (247.8 / (T + 133.15)); }

function colebrook(Re: number, rel: number): number {
  let f = 0.02;
  for (let i = 0; i < 40; i++) f = (-2 * Math.log10(rel / 3.7 + 2.51 / (Re * Math.sqrt(f)))) ** -2;
  return f;
}

function frictionFactor(Re: number, rel: number): number {
  if (Re < 2300) return 64 / Re;
  if (Re > 4000) return colebrook(Re, rel);
  const s = (Re - 2300) / 1700;
  return (1 - s) * (64 / 2300) + s * colebrook(4000, rel);
}

/** In-place radix-2 FFT of real data; returns magnitude of bins 0..N/2. */
function fftMag(x: number[]): number[] {
  const N = x.length;
  const re = x.slice(), im = new Array<number>(N).fill(0);
  for (let i = 1, j = 0; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; }
  }
  for (let len = 2; len <= N; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < N; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k), wi = Math.sin(ang * k);
        const ar = re[i + k + len / 2], ai = im[i + k + len / 2];
        const tr = ar * wr - ai * wi, ti = ar * wi + ai * wr;
        re[i + k + len / 2] = re[i + k] - tr; im[i + k + len / 2] = im[i + k] - ti;
        re[i + k] += tr; im[i + k] += ti;
      }
    }
  }
  return Array.from({ length: N / 2 + 1 }, (_, k) => Math.hypot(re[k], im[k]));
}

function windowFn(kind: number, N: number): number[] {
  return Array.from({ length: N }, (_, i) => {
    const a = (2 * Math.PI * i) / N;
    if (kind === 1) return 1;
    if (kind === 2) return 0.21557895 - 0.41663158 * Math.cos(a) + 0.277263158 * Math.cos(2 * a) - 0.083578947 * Math.cos(3 * a) + 0.006947368 * Math.cos(4 * a);
    return 0.5 - 0.5 * Math.cos(a);
  });
}

// ------------------------------------------------------------------ materials

const TENSILE = [
  { name: 'S275 structural steel', E: 205e3, sy: 290, su: 450, eu: 0.17, ef: 0.3, ra: 0.6, yieldPoint: true },
  { name: '6061-T6 aluminium', E: 69e3, sy: 276, su: 310, eu: 0.08, ef: 0.12, ra: 0.4, yieldPoint: false },
  { name: 'C11000 copper, annealed', E: 117e3, sy: 70, su: 220, eu: 0.38, ef: 0.45, ra: 0.75, yieldPoint: false },
  { name: 'Ti-6Al-4V, annealed', E: 114e3, sy: 880, su: 950, eu: 0.08, ef: 0.14, ra: 0.35, yieldPoint: false },
];

function tensileCurve(m: (typeof TENSILE)[number], k: number): [number, number][] {
  const E = m.E, sy = m.sy * k, su = m.su * k;
  const pts: [number, number][] = [];
  if (m.yieldPoint) {
    const eUpper = (1.06 * sy) / E;
    for (const e of lin(0, eUpper, 30)) pts.push([e, E * e]);
    const eL = 0.018;
    for (const e of lin(eUpper, eL, 20)) pts.push([e, sy * (1 + 0.004 * Math.sin(e * 3000))]);
    for (const e of lin(eL, m.eu, 60)) { const s = (e - eL) / (m.eu - eL); pts.push([e, sy + (su - sy) * (1 - (1 - s) ** 2.2)]); }
  } else {
    // Elastic to a proportional limit, then a saturating hardening law tuned so the 0.2 % offset
    // yield lands on sy.
    const sp = 0.8 * sy, ep = sp / E;
    let lo = 1e-4, hi = 0.2;
    const sig = (e: number, lam: number) => (e <= ep ? E * e : su - (su - sp) * Math.exp(-(e - ep) / lam));
    for (let it = 0; it < 60; it++) {
      const lam = (lo + hi) / 2;
      let a = ep, b = 0.05;
      for (let j = 0; j < 60; j++) { const c = (a + b) / 2; if (sig(c, lam) - E * (c - 0.002) > 0) a = c; else b = c; }
      if (sig(a, lam) > sy) lo = lam; else hi = lam;
    }
    const lam = (lo + hi) / 2;
    for (const e of lin(0, ep, 30)) pts.push([e, E * e]);
    for (const e of lin(ep, m.eu, 90)) pts.push([e, sig(e, lam)]);
  }
  const top = pts[pts.length - 1][1];
  for (const e of lin(m.eu, m.ef, 40)) { const s = (e - m.eu) / (m.ef - m.eu); pts.push([e, top * (1 - 0.22 * s ** 1.8)]); }
  return pts;
}

const tensile: Bench = {
  id: 'bench-tensile',
  title: 'Tensile test',
  instrument: 'Universal testing machine with clip-on extensometer',
  standards: ['ASTM E8/E8M', 'ISO 6892-1'],
  summary: 'Pulls a round specimen to fracture and reduces the load–extension record to modulus, 0.2 % offset yield, tensile strength, elongation and reduction of area.',
  inputs: [
    { key: 'mat', label: 'Material', value: 0, options: opt(TENSILE.map((m) => m.name)) },
    { key: 'd0', label: 'Specimen diameter', unit: 'mm', value: 10, min: 2, max: 30, step: 0.5 },
    { key: 'L0', label: 'Gauge length', unit: 'mm', value: 50, min: 10, max: 200, step: 1 },
    { key: 'spec', label: 'Specified minimum yield', unit: 'MPa', value: 275, min: 0, max: 2000, step: 5 },
    seedInput,
  ],
  run(v) {
    const m = TENSILE[v.mat] ?? TENSILE[0];
    const r = rng(v.seed);
    const k = 1 + 0.02 * r.gauss();
    const curve = tensileCurve(m, k).map(([e, s]) => [e, s * (1 + 0.002 * r.gauss())] as [number, number]);
    const A0 = (Math.PI * v.d0 * v.d0) / 4;
    const elastic = curve.filter(([, s]) => s > 0.1 * m.sy * k && s < 0.5 * m.sy * k);
    const E = linfit(elastic).slope;
    const off = curve.find(([e, s]) => e > 0.002 && s <= E * (e - 0.002));
    const rp = off ? off[1] : NaN;
    const iu = curve.reduce((bi, p, i) => (p[1] > curve[bi][1] ? i : bi), 0);
    const uts = curve[iu][1];
    const ef = curve[curve.length - 1][0];
    const Aperc = (ef - curve[curve.length - 1][1] / E) * 100;
    const Z = m.ra * (1 + 0.03 * r.gauss()) * 100;
    let tough = 0;
    for (let i = 1; i < curve.length; i++) tough += 0.5 * (curve[i][1] + curve[i - 1][1]) * (curve[i][0] - curve[i - 1][0]);
    const trueCurve = curve.slice(0, iu + 1).map(([e, s]) => [Math.log(1 + e), s * (1 + e)] as [number, number]);
    const pass = rp >= v.spec;
    return {
      results: [
        { label: "Young's modulus E", value: `${n(E / 1000, 1)} GPa` },
        { label: 'Yield strength Rp0.2', value: `${n(rp, 0)} MPa` },
        { label: 'Tensile strength Rm', value: `${n(uts, 0)} MPa` },
        { label: 'Maximum load', value: `${n((uts * A0) / 1000, 2)} kN` },
        { label: 'Uniform elongation Ag', value: `${n(curve[iu][0] * 100, 1)} %` },
        { label: 'Elongation after fracture A', value: `${n(Aperc, 1)} % (L₀ = ${v.L0} mm)` },
        { label: 'Reduction of area Z', value: `${n(Z, 0)} %` },
        { label: 'Modulus of toughness', value: `${n(tough, 1)} MJ/m³` },
        { label: 'Yield ratio Rp0.2 / Rm', value: n(rp / uts, 2) },
      ],
      charts: [{
        title: 'Stress–strain', xLabel: 'strain', yLabel: 'stress (MPa)',
        series: [{ label: 'engineering', points: curve }, { label: 'true (to necking)', points: trueCurve, style: 'dashed', color: '--d-thermal' }],
        marks: [{ y: rp, label: `Rp0.2 ${rp.toFixed(0)}` }],
      }],
      verdict: { pass, text: pass ? `Rp0.2 ${rp.toFixed(0)} MPa meets the ${v.spec} MPa minimum.` : `Rp0.2 ${rp.toFixed(0)} MPa is below the ${v.spec} MPa minimum.` },
      notes: m.yieldPoint ? ['This steel shows an upper and lower yield point; ASTM E8 reports the lower yield or the 0.2 % offset value.'] : undefined,
      record: { material: m.name, 'Rp0.2 (MPa)': rp.toFixed(0), 'Rm (MPa)': uts.toFixed(0), 'A (%)': Aperc.toFixed(1) },
    };
  },
};

// ------------------------------------------------------------------

const CHARPY = [
  { name: 'S275JR structural steel (BCC)', LS: 4, US: 120, T0: 5, C: 15 },
  { name: 'S355J2 fine-grain steel (BCC)', LS: 5, US: 180, T0: -35, C: 14 },
  { name: '304 stainless steel (FCC)', LS: 140, US: 170, T0: -200, C: 60 },
  { name: '6061-T6 aluminium (FCC)', LS: 12, US: 16, T0: -100, C: 80 },
];

const charpy: Bench = {
  id: 'bench-charpy',
  title: 'Charpy V-notch impact',
  instrument: 'Pendulum impact tester, 300 J, with conditioning bath',
  standards: ['ASTM E23', 'ISO 148-1'],
  summary: 'Breaks three notched bars at a set temperature and places them on the ductile–brittle transition curve.',
  inputs: [
    { key: 'mat', label: 'Material', value: 0, options: opt(CHARPY.map((m) => m.name)) },
    { key: 'T', label: 'Test temperature', unit: '°C', value: 0, min: -196, max: 150, step: 1 },
    { key: 'req', label: 'Required average energy', unit: 'J', value: 27, min: 0, max: 300, step: 1 },
    seedInput,
  ],
  run(v) {
    const m = CHARPY[v.mat] ?? CHARPY[0];
    const r = rng(v.seed);
    const E = (T: number) => m.LS + ((m.US - m.LS) / 2) * (1 + Math.tanh((T - m.T0) / m.C));
    const mean = E(v.T);
    const spread = 2 + 0.1 * mean + 0.25 * (m.US - m.LS) * (1 - Math.abs(Math.tanh((v.T - m.T0) / m.C)));
    const bars = [0, 1, 2].map(() => Math.max(1, Math.min(300, mean + spread * r.gauss() * 0.5)));
    const avg = bars.reduce((a, b) => a + b, 0) / 3;
    const shear = Math.max(0, Math.min(100, (100 * (avg - m.LS)) / Math.max(1, m.US - m.LS)));
    const t27 = m.LS < 27 && m.US > 27 ? m.T0 + m.C * Math.atanh((2 * (27 - m.LS)) / (m.US - m.LS) - 1) : NaN;
    const minBar = Math.min(...bars);
    const pass = avg >= v.req && minBar >= (2 / 3) * v.req;
    return {
      results: [
        { label: 'Absorbed energy KV₂ (3 bars)', value: bars.map((b) => `${b.toFixed(0)} J`).join(' · ') },
        { label: 'Average', value: `${avg.toFixed(1)} J` },
        { label: 'Shear fracture appearance', value: `${shear.toFixed(0)} %` },
        { label: 'Lateral expansion (est.)', value: `${Math.min(2.4, 0.016 * avg).toFixed(2)} mm` },
        { label: 'Transition midpoint (DBTT)', value: m.US - m.LS > 30 ? `${m.T0.toFixed(0)} °C` : 'no transition (FCC)' },
        { label: 'T₂₇J', value: Number.isFinite(t27) ? `${t27.toFixed(0)} °C` : '—' },
      ],
      charts: [{
        title: 'Ductile–brittle transition', xLabel: 'temperature (°C)', yLabel: 'absorbed energy (J)',
        series: [
          { label: 'tanh fit', points: lin(-150, 100, 120).map((T) => [T, E(T)]) },
          { label: 'this test', points: bars.map((b) => [v.T, b]), style: 'points', color: '--d-thermal' },
        ],
        marks: [{ y: v.req, label: `${v.req} J requirement` }],
      }],
      verdict: { pass, text: pass ? `Average ${avg.toFixed(0)} J meets ${v.req} J and no bar is below two-thirds of it.` : `Fails: average ${avg.toFixed(0)} J (needs ${v.req} J) or a bar below ${((2 / 3) * v.req).toFixed(0)} J.` },
      record: { material: m.name, 'T (°C)': String(v.T), 'avg (J)': avg.toFixed(1) },
    };
  },
};

// ------------------------------------------------------------------

const FATIGUE = [
  { name: 'S355 structural steel', su: 510, endurance: true },
  { name: 'AISI 4140 quenched and tempered', su: 1000, endurance: true },
  { name: '7075-T6 aluminium', su: 570, endurance: false },
];

const fatigue: Bench = {
  id: 'bench-fatigue',
  title: 'Fatigue S–N curve',
  instrument: 'Rotating-beam or servo-hydraulic fatigue machine',
  standards: ['ASTM E466', 'ASTM E739', 'ISO 1143'],
  summary: 'Builds an S–N curve from a specimen series, applies Marin factors and the Goodman mean-stress correction, and predicts life at a design point.',
  inputs: [
    { key: 'mat', label: 'Material', value: 0, options: opt(FATIGUE.map((m) => m.name)) },
    { key: 'sa', label: 'Stress amplitude σa', unit: 'MPa', value: 200, min: 1, max: 1500, step: 5 },
    { key: 'sm', label: 'Mean stress σm', unit: 'MPa', value: 50, min: -500, max: 1500, step: 5 },
    { key: 'ka', label: 'Surface factor ka', value: 0.85, min: 0.3, max: 1, step: 0.01 },
    { key: 'kb', label: 'Size factor kb', value: 0.9, min: 0.5, max: 1, step: 0.01 },
    { key: 'life', label: 'Design life', unit: 'cycles', value: 1e6, min: 1e3, max: 1e9, step: 1e5 },
    seedInput,
  ],
  run(v) {
    const m = FATIGUE[v.mat] ?? FATIGUE[0];
    const r = rng(v.seed);
    const Se = (m.endurance ? 0.5 * Math.min(m.su, 1400) : 0.4 * m.su) * v.ka * v.kb;
    const Nref = m.endurance ? 1e6 : 5e8;
    const f = 0.9;
    const a = (f * m.su) ** 2 / Se;
    const b = -Math.log10((f * m.su) / Se) / Math.log10(Nref / 1e3);
    const life = (s: number) => (m.endurance && s <= Se ? Infinity : (s / a) ** (1 / b));
    const sar = v.sm >= m.su ? Infinity : v.sa / (1 - Math.max(0, v.sm) / m.su);
    const N = life(sar);
    const nf = 1 / (v.sa / Se + Math.max(0, v.sm) / m.su);
    const levels = lin(0.85 * m.su, 0.95 * Se, 8);
    const specimens = levels.map((s) => {
      const Nl = life(s);
      const Nmeas = Number.isFinite(Nl) ? Nl * 10 ** (0.2 * r.gauss()) : 1e7;
      return [Math.min(Nmeas, m.endurance ? 1e7 : 1e9), s] as [number, number];
    });
    const curve = logspace(1e3, m.endurance ? 1e8 : 1e9, 60).map((Nc) => [Nc, m.endurance && Nc > Nref ? Se : a * Nc ** b] as [number, number]);
    const pass = N >= v.life;
    return {
      results: [
        { label: 'Endurance limit Se (with ka, kb)', value: `${Se.toFixed(0)} MPa${m.endurance ? '' : ` at ${Nref.toExponential(0)} cycles (no true limit)`}` },
        { label: 'Basquin line', value: `σ = ${a.toFixed(0)} · N^${b.toFixed(4)} MPa` },
        { label: 'Goodman equivalent amplitude', value: Number.isFinite(sar) ? `${sar.toFixed(0)} MPa` : 'static failure (σm ≥ Su)' },
        { label: 'Predicted life', value: Number.isFinite(N) ? `${N.toExponential(2)} cycles` : 'infinite (below endurance limit)' },
        { label: 'Goodman safety factor', value: nf.toFixed(2) },
      ],
      charts: [{
        title: 'S–N curve', xLabel: 'cycles to failure N', yLabel: 'stress amplitude (MPa)', xLog: true, yLog: true,
        series: [{ label: 'design curve', points: curve }, { label: 'specimens', points: specimens, style: 'points', color: '--d-thermal' }],
        marks: Number.isFinite(sar) ? [{ y: sar, label: `design point ${sar.toFixed(0)} MPa` }] : [],
      }],
      verdict: { pass, text: pass ? `Life ${Number.isFinite(N) ? N.toExponential(1) : '∞'} ≥ ${v.life.toExponential(0)} cycles.` : `Life ${N.toExponential(1)} is short of ${v.life.toExponential(0)} cycles.` },
      notes: ['Specimen points carry log-normal scatter (σ log N = 0.2). Runouts are plotted at the test cut-off.'],
      record: { material: m.name, 'σa eq (MPa)': Number.isFinite(sar) ? sar.toFixed(0) : '∞', N: Number.isFinite(N) ? N.toExponential(2) : '∞' },
    };
  },
};

// ------------------------------------------------------------------

const HARD = [
  { name: 'Mild steel (≈130 HB)', HB: 130, ratio: 30, k: 3.45 },
  { name: 'Medium-carbon steel, normalised (≈200 HB)', HB: 200, ratio: 30, k: 3.45 },
  { name: 'Brass CW617N (≈110 HB)', HB: 110, ratio: 10, k: 3.3 },
  { name: 'Aluminium 6082-T6 (≈95 HB)', HB: 95, ratio: 10, k: 3.4 },
];

const hardness: Bench = {
  id: 'bench-hardness',
  title: 'Brinell hardness',
  instrument: 'Brinell tester with 10 mm carbide ball and measuring microscope',
  standards: ['ASTM E10', 'ISO 6506-1'],
  summary: 'Makes three indentations, measures two diameters each, and converts to HBW with an estimate of tensile strength.',
  inputs: [
    { key: 'mat', label: 'Material', value: 0, options: opt(HARD.map((m) => m.name)) },
    { key: 'P', label: 'Test force', unit: 'kgf', value: 3000, options: [{ value: 3000, label: '3000 kgf (steel)' }, { value: 1000, label: '1000 kgf (Cu alloys)' }, { value: 500, label: '500 kgf (Al alloys)' }] },
    { key: 'D', label: 'Ball diameter', unit: 'mm', value: 10, options: [{ value: 10, label: '10 mm' }, { value: 5, label: '5 mm' }] },
    seedInput,
  ],
  run(v) {
    const m = HARD[v.mat] ?? HARD[0];
    const r = rng(v.seed);
    const D = v.D, P = v.P * (D === 5 ? 0.25 : 1);
    const hb = (d: number) => (2 * P) / (Math.PI * D * (D - Math.sqrt(D * D - d * d)));
    const dFor = (H: number) => { let lo = 0.01, hi = D * 0.999; for (let i = 0; i < 60; i++) { const c = (lo + hi) / 2; if (hb(c) > H) lo = c; else hi = c; } return (lo + hi) / 2; };
    const indents = [0, 1, 2].map(() => {
      const H = m.HB * (1 + 0.025 * r.gauss());
      const d0 = dFor(H);
      const d1 = d0 * (1 + 0.004 * r.gauss()), d2 = d0 * (1 + 0.004 * r.gauss());
      return { d1, d2, d: (d1 + d2) / 2 };
    });
    const values = indents.map((i) => hb(i.d));
    const mean = values.reduce((a, b) => a + b, 0) / 3;
    const dm = indents.reduce((a, b) => a + b.d, 0) / 3;
    const valid = dm >= 0.24 * D && dm <= 0.6 * D;
    const ratio = P / (D * D);
    const ratioOk = Math.abs(ratio - m.ratio) / m.ratio < 0.5;
    return {
      results: [
        ...indents.map((i, k) => ({ label: `Indent ${k + 1} (d₁, d₂)`, value: `${i.d1.toFixed(3)}, ${i.d2.toFixed(3)} mm → ${values[k].toFixed(0)} HBW` })),
        { label: 'Mean hardness', value: `${mean.toFixed(0)} HBW ${D}/${P.toFixed(0)}` },
        { label: 'Tensile strength (estimate)', value: `≈ ${(m.k * mean).toFixed(0)} MPa` },
        { label: 'Force–diameter ratio 0.102·F/D²', value: `${ratio.toFixed(0)} (recommended ${m.ratio} for this material)` },
      ],
      charts: [{
        title: 'Hardness against indentation diameter', xLabel: 'indentation diameter d (mm)', yLabel: 'HBW',
        series: [{ label: `F = ${P.toFixed(0)} kgf, D = ${D} mm`, points: lin(0.2 * D, 0.65 * D, 60).map((d) => [d, hb(d)]) }, { label: 'readings', points: indents.map((i, k) => [i.d, values[k]]), style: 'points', color: '--d-thermal' }],
        marks: [{ x: 0.24 * D, label: '0.24 D' }, { x: 0.6 * D, label: '0.6 D' }],
      }],
      verdict: { pass: valid && ratioOk, text: valid ? (ratioOk ? 'Indentations are in the valid 0.24 D – 0.6 D band.' : 'Valid size, but the force–diameter ratio does not suit this material.') : 'Invalid: indentation outside 0.24 D – 0.6 D. Change the force.' },
      record: { material: m.name, 'HBW': mean.toFixed(0) },
    };
  },
};

// ------------------------------------------------------------------

const TORSION = [
  { name: 'Mild steel', G: 79.3e3, ty: 165 },
  { name: 'Aluminium 6061-T6', G: 26e3, ty: 160 },
  { name: 'Brass', G: 39e3, ty: 110 },
];

const torsion: Bench = {
  id: 'bench-torsion',
  title: 'Torsion test',
  instrument: 'Torsion testing machine with troptometer',
  standards: ['ASTM E143'],
  summary: 'Twists a solid round bar past yield and finds the modulus of rigidity from the elastic slope.',
  inputs: [
    { key: 'mat', label: 'Material', value: 0, options: opt(TORSION.map((m) => m.name)) },
    { key: 'd', label: 'Diameter', unit: 'mm', value: 10, min: 3, max: 40, step: 0.5 },
    { key: 'L', label: 'Gauge length', unit: 'mm', value: 200, min: 20, max: 1000, step: 5 },
    seedInput,
  ],
  run(v) {
    const m = TORSION[v.mat] ?? TORSION[0];
    const r = rng(v.seed);
    const J = (Math.PI * v.d ** 4) / 32; // mm⁴
    const Ty = (m.ty * J) / (v.d / 2) / 1000; // N·m
    const thy = (Ty * 1000 * v.L) / (m.G * J); // rad
    const T = (th: number) => (th <= thy ? (Ty * th) / thy : (4 / 3) * Ty * (1 - 0.25 * (thy / th) ** 3));
    const pts = lin(0, 6 * thy, 40).map((th) => [(th * 180) / Math.PI * (1 + 0.004 * r.gauss()), T(th) * (1 + 0.003 * r.gauss())] as [number, number]);
    const el = pts.filter(([, t]) => t > 0.05 * Ty && t < 0.7 * Ty).map(([deg, t]) => [(deg * Math.PI) / 180, t] as [number, number]);
    const fit = linfit(el);
    const G = (fit.slope * 1000 * v.L) / J;
    return {
      results: [
        { label: 'Modulus of rigidity G', value: `${(G / 1000).toFixed(1)} GPa (handbook ${(m.G / 1000).toFixed(1)})` },
        { label: 'Polar moment J', value: `${J.toFixed(0)} mm⁴` },
        { label: 'Yield torque Ty', value: `${Ty.toFixed(1)} N·m at ${((thy * 180) / Math.PI).toFixed(2)}°` },
        { label: 'Fully plastic torque Tp = 4/3·Ty', value: `${((4 / 3) * Ty).toFixed(1)} N·m` },
        { label: 'Shear yield stress τy', value: `${m.ty} MPa` },
      ],
      charts: [{
        title: 'Torque against twist', xLabel: 'twist (°)', yLabel: 'torque (N·m)',
        series: [{ label: 'readings', points: pts, style: 'points' }, { label: 'elastic fit', points: [[0, fit.intercept], [((1.2 * thy * 180) / Math.PI), fit.slope * 1.2 * thy + fit.intercept]], color: '--d-thermal' }],
      }],
      record: { material: m.name, 'G (GPa)': (G / 1000).toFixed(1) },
    };
  },
};

// ------------------------------------------------------------------

const SPRINGS = [
  { name: 'Music wire ASTM A228', G: 79.3e3, A: 2211, m: 0.145 },
  { name: 'Stainless 302 ASTM A313', G: 69e3, A: 1867, m: 0.146 },
  { name: 'Phosphor bronze B159', G: 41e3, A: 932, m: 0.064 },
];

const springTest: Bench = {
  id: 'bench-spring',
  title: 'Helical spring test',
  instrument: 'Digital spring testing machine (200 kg)',
  standards: ['EN 13906-1'],
  summary: 'Loads a compression spring in steps, fits its rate, and checks the Wahl-corrected shear stress against the wire strength.',
  inputs: [
    { key: 'mat', label: 'Wire', value: 0, options: opt(SPRINGS.map((m) => m.name)) },
    { key: 'd', label: 'Wire diameter', unit: 'mm', value: 3, min: 0.5, max: 12, step: 0.1 },
    { key: 'D', label: 'Mean coil diameter', unit: 'mm', value: 24, min: 3, max: 150, step: 0.5 },
    { key: 'Na', label: 'Active coils', value: 8, min: 2, max: 40, step: 0.5 },
    { key: 'F', label: 'Maximum test load', unit: 'N', value: 200, min: 1, max: 2000, step: 5 },
    seedInput,
  ],
  run(v) {
    const m = SPRINGS[v.mat] ?? SPRINGS[0];
    const r = rng(v.seed);
    const k = (m.G * v.d ** 4) / (8 * v.D ** 3 * v.Na);
    const pts = lin(0, v.F, 11).map((F) => [(F / k) * (1 + 0.005 * r.gauss()) + 0.02 * r.gauss(), F] as [number, number]);
    const fit = linfit(pts.map(([x, F]) => [x, F]));
    const C = v.D / v.d;
    const Kw = (4 * C - 1) / (4 * C - 4) + 0.615 / C;
    const tau = (Kw * 8 * v.F * v.D) / (Math.PI * v.d ** 3);
    const sut = m.A / v.d ** m.m;
    const allow = 0.45 * sut;
    const ok = tau <= allow && C >= 4 && C <= 12;
    return {
      results: [
        { label: 'Measured rate k', value: `${fit.slope.toFixed(2)} N/mm (theory ${k.toFixed(2)})` },
        { label: 'Spring index C = D/d', value: C.toFixed(2) },
        { label: 'Wahl factor Kw', value: Kw.toFixed(3) },
        { label: 'Shear stress at max load', value: `${tau.toFixed(0)} MPa` },
        { label: 'Allowable (0.45·Sut)', value: `${allow.toFixed(0)} MPa (Sut ${sut.toFixed(0)} MPa)` },
        { label: 'Deflection at max load', value: `${(v.F / k).toFixed(2)} mm` },
      ],
      charts: [{
        title: 'Load against deflection', xLabel: 'deflection (mm)', yLabel: 'load (N)',
        series: [{ label: 'readings', points: pts, style: 'points' }, { label: 'fit', points: [[0, fit.intercept], [v.F / k, (fit.slope * v.F) / k + fit.intercept]], color: '--d-thermal' }],
      }],
      verdict: { pass: ok, text: ok ? 'Stress within the static allowable and index in the 4–12 band.' : C < 4 || C > 12 ? 'Spring index outside 4–12 (hard to coil or prone to buckling and tangling).' : 'Overstressed at the maximum load.' },
      record: { wire: m.name, 'k (N/mm)': fit.slope.toFixed(2), 'τ (MPa)': tau.toFixed(0) },
    };
  },
};

// ------------------------------------------------------------------

const morse: Bench = {
  id: 'bench-morse',
  title: 'Morse test',
  instrument: 'Multi-cylinder engine on a hydraulic or eddy-current dynamometer',
  standards: ['BS 5514 (ISO 3046) test conditions'],
  summary: 'Cuts out each cylinder in turn at constant speed; the drop in brake power gives that cylinder’s indicated power, and their sum gives friction power and mechanical efficiency.',
  inputs: [
    { key: 'z', label: 'Cylinders', value: 4, options: [{ value: 4, label: '4' }, { value: 6, label: '6' }] },
    { key: 'rpm', label: 'Speed', unit: 'rpm', value: 1500, min: 600, max: 6000, step: 50 },
    { key: 'bp', label: 'Brake power, all firing', unit: 'kW', value: 20, min: 1, max: 400, step: 0.5 },
    { key: 'fp', label: 'True friction power', unit: 'kW', value: 5, min: 0.2, max: 100, step: 0.1 },
    seedInput,
  ],
  run(v) {
    const r = rng(v.seed);
    const z = v.z;
    const share = Array.from({ length: z }, () => 1 + 0.04 * r.gauss());
    const tot = share.reduce((a, b) => a + b, 0);
    const ip = share.map((s) => ((v.bp + v.fp) * s) / tot);
    const cut = ip.map((x) => v.bp - x + 0.08 * r.gauss());
    const ipMeas = cut.map((c) => v.bp - c);
    const IP = ipMeas.reduce((a, b) => a + b, 0);
    const FP = IP - v.bp;
    const torque = (v.bp * 1000) / ((2 * Math.PI * v.rpm) / 60);
    return {
      results: [
        ...cut.map((c, i) => ({ label: `Cylinder ${i + 1} cut out: BP`, value: `${c.toFixed(2)} kW → IP${i + 1} = ${ipMeas[i].toFixed(2)} kW` })),
        { label: 'Indicated power IP', value: `${IP.toFixed(2)} kW` },
        { label: 'Friction power FP = IP − BP', value: `${FP.toFixed(2)} kW` },
        { label: 'Mechanical efficiency', value: `${((100 * v.bp) / IP).toFixed(1)} %` },
        { label: 'Brake torque', value: `${torque.toFixed(1)} N·m` },
      ],
      charts: [{
        title: 'Indicated power by cylinder', xLabel: 'cylinder', yLabel: 'indicated power (kW)',
        series: [{ label: 'IP per cylinder', points: ipMeas.map((x, i) => [i + 1, x]), style: 'bars' }],
        marks: [{ y: IP / z, label: 'mean' }],
      }],
      notes: ['The Morse test assumes friction and pumping losses do not change when a cylinder is cut out; the dynamometer load is reduced to bring the speed back each time.'],
      record: { 'IP (kW)': IP.toFixed(2), 'FP (kW)': FP.toFixed(2), 'ηm (%)': ((100 * v.bp) / IP).toFixed(1) },
    };
  },
};

// ------------------------------------------------------------------

const ROUGH = [{ label: 'Drawn copper (0.0015 mm)', value: 0.0015 }, { label: 'Commercial steel (0.045 mm)', value: 0.045 }, { label: 'Galvanised iron (0.15 mm)', value: 0.15 }, { label: 'Cast iron (0.26 mm)', value: 0.26 }];

const pipeFriction: Bench = {
  id: 'bench-pipe-friction',
  title: 'Pipe friction loop',
  instrument: 'Pipe-flow rig with differential manometer and weighing tank',
  summary: 'Measures pressure drop over a straight pipe at ten flow rates and plots the Darcy friction factor on a Moody chart against Colebrook.',
  inputs: [
    { key: 'D', label: 'Inner diameter', unit: 'mm', value: 25, min: 5, max: 200, step: 0.5 },
    { key: 'L', label: 'Test length', unit: 'm', value: 3, min: 0.5, max: 50, step: 0.1 },
    { key: 'eps', label: 'Wall roughness', unit: 'mm', value: 0.0015, options: ROUGH },
    { key: 'Q', label: 'Maximum flow', unit: 'L/s', value: 2, min: 0.01, max: 50, step: 0.01 },
    { key: 'T', label: 'Water temperature', unit: '°C', value: 20, min: 1, max: 90, step: 1 },
    seedInput,
  ],
  run(v) {
    const r = rng(v.seed);
    const rho = 1000 - 0.0178 * Math.abs(v.T - 4) ** 1.7;
    const mu = waterViscosity(v.T);
    const D = v.D / 1000, A = (Math.PI * D * D) / 4, rel = v.eps / v.D;
    const rows = logspace(v.Q * 0.02, v.Q, 12).map((q) => {
      const Q = q / 1000, V = Q / A, Re = (rho * V * D) / mu;
      const f = frictionFactor(Re, rel);
      const dp = f * (v.L / D) * 0.5 * rho * V * V * (1 + 0.012 * r.gauss()) + 2 * r.gauss();
      const fm = dp / ((v.L / D) * 0.5 * rho * V * V);
      return { q, V, Re, f, dp, fm };
    });
    const last = rows[rows.length - 1];
    const haaland = (-1.8 * Math.log10((rel / 3.7) ** 1.11 + 6.9 / last.Re)) ** -2;
    const reCurve = logspace(600, Math.max(1e6, last.Re * 2), 80);
    return {
      results: [
        { label: 'At maximum flow: velocity', value: `${last.V.toFixed(2)} m/s` },
        { label: 'Reynolds number', value: last.Re.toExponential(3) },
        { label: 'Measured friction factor', value: last.fm.toFixed(4) },
        { label: 'Colebrook / Haaland', value: `${last.f.toFixed(4)} / ${haaland.toFixed(4)}` },
        { label: 'Pressure drop', value: `${(last.dp / 1000).toFixed(2)} kPa` },
        { label: 'Head loss hf', value: `${(last.dp / (rho * 9.81)).toFixed(3)} m` },
        { label: 'Relative roughness ε/D', value: rel.toExponential(2) },
      ],
      charts: [
        {
          title: 'Moody chart', xLabel: 'Reynolds number', yLabel: 'Darcy friction factor', xLog: true, yLog: true,
          series: [
            { label: 'laminar 64/Re', points: reCurve.filter((x) => x < 4000).map((x) => [x, 64 / x]), style: 'dashed', color: '--text-2' },
            { label: `Colebrook ε/D = ${rel.toExponential(1)}`, points: reCurve.filter((x) => x > 2300).map((x) => [x, colebrook(x, rel)]) },
            { label: 'measured', points: rows.map((x) => [x.Re, x.fm]), style: 'points', color: '--d-thermal' },
          ],
          marks: [{ x: 2300, label: 'Re 2300' }],
        },
        { title: 'Pressure drop against flow', xLabel: 'flow (L/s)', yLabel: 'Δp (kPa)', series: [{ label: 'measured', points: rows.map((x) => [x.q, x.dp / 1000]), style: 'points', color: '--d-fluid' }] },
      ],
      record: { 'Re max': last.Re.toExponential(2), 'f meas': last.fm.toFixed(4), 'f Colebrook': last.f.toFixed(4) },
    };
  },
};

// ------------------------------------------------------------------

const venturi: Bench = {
  id: 'bench-venturi',
  title: 'Venturimeter calibration',
  instrument: 'Venturi with piezometer taps, U-tube manometer, collecting tank and stopwatch',
  standards: ['ISO 5167-4'],
  summary: 'Times the actual flow into a tank against the inlet-to-throat head and finds the discharge coefficient Cd.',
  inputs: [
    { key: 'D1', label: 'Inlet diameter', unit: 'mm', value: 28, min: 5, max: 300, step: 0.5 },
    { key: 'D2', label: 'Throat diameter', unit: 'mm', value: 14, min: 2, max: 250, step: 0.5 },
    { key: 'Q', label: 'Maximum flow', unit: 'L/s', value: 1.5, min: 0.01, max: 50, step: 0.01 },
    seedInput,
  ],
  run(v) {
    const r = rng(v.seed);
    const beta = v.D2 / v.D1;
    const A2 = (Math.PI * (v.D2 / 1000) ** 2) / 4;
    const K = A2 * Math.sqrt((2 * 9.81) / (1 - beta ** 4));
    const rows = lin(0.25 * v.Q, v.Q, 8).map((q) => {
      const Q = q / 1000;
      const Re = (4 * Q) / (Math.PI * (v.D1 / 1000) * 1.0e-6);
      const Cd = 0.985 - 0.6 / Math.sqrt(Re / 100);
      const h = (Q / (Cd * K)) ** 2 * (1 + 0.01 * r.gauss());
      return { Q: Q * (1 + 0.006 * r.gauss()), h, Re, Cd: Q / (K * Math.sqrt(h)) };
    });
    const fit = linfit(rows.map((x) => [Math.sqrt(x.h), x.Q]));
    const Cd = fit.slope / K;
    return {
      results: [
        { label: 'Area ratio β = D₂/D₁', value: beta.toFixed(3) },
        { label: 'Discharge coefficient Cd (slope)', value: Cd.toFixed(3) },
        { label: 'Cd range over the runs', value: `${Math.min(...rows.map((x) => x.Cd)).toFixed(3)} – ${Math.max(...rows.map((x) => x.Cd)).toFixed(3)}` },
        { label: 'Meter constant K = A₂√(2g/(1−β⁴))', value: `${K.toExponential(3)} m^2.5/s` },
        { label: 'Head at maximum flow', value: `${(rows[rows.length - 1].h * 1000).toFixed(0)} mm of water` },
      ],
      charts: [
        { title: 'Flow against √Δh', xLabel: '√Δh (√m)', yLabel: 'Q (m³/s)', series: [{ label: 'readings', points: rows.map((x) => [Math.sqrt(x.h), x.Q]), style: 'points', color: '--d-fluid' }, { label: `fit, Cd = ${Cd.toFixed(3)}`, points: [[0, fit.intercept], [Math.sqrt(rows[rows.length - 1].h), fit.slope * Math.sqrt(rows[rows.length - 1].h) + fit.intercept]] }] },
        { title: 'Discharge coefficient against Reynolds number', xLabel: 'Re (inlet)', yLabel: 'Cd', series: [{ label: 'Cd', points: rows.map((x) => [x.Re, x.Cd]), style: 'points' }] },
      ],
      record: { 'β': beta.toFixed(3), Cd: Cd.toFixed(3) },
    };
  },
};

// ------------------------------------------------------------------

const reynolds: Bench = {
  id: 'bench-reynolds',
  title: "Reynolds' experiment",
  instrument: 'Glass pipe with dye injector, constant-head tank and measuring cylinder',
  summary: 'Sets a flow, computes the Reynolds number and shows what the dye filament does and how the velocity profile changes.',
  inputs: [
    { key: 'D', label: 'Pipe diameter', unit: 'mm', value: 15, min: 3, max: 60, step: 0.5 },
    { key: 'Q', label: 'Flow rate', unit: 'mL/s', value: 20, min: 0.5, max: 2000, step: 0.5 },
    { key: 'T', label: 'Water temperature', unit: '°C', value: 20, min: 1, max: 90, step: 1 },
  ],
  run(v) {
    const mu = waterViscosity(v.T);
    const D = v.D / 1000, A = (Math.PI * D * D) / 4;
    const V = v.Q / 1e6 / A;
    const Re = (1000 * V * D) / mu;
    const regime = Re < 2300 ? 'laminar' : Re < 4000 ? 'transitional' : 'turbulent';
    const qc = (Re0: number) => ((Re0 * mu) / (1000 * D)) * A * 1e6;
    const prof = lin(-1, 1, 81);
    return {
      results: [
        { label: 'Mean velocity', value: `${(V * 100).toFixed(2)} cm/s` },
        { label: 'Kinematic viscosity', value: `${((mu / 1000) * 1e6).toFixed(3)} mm²/s` },
        { label: 'Reynolds number', value: Re.toFixed(0) },
        { label: 'Regime', value: regime },
        { label: 'Flow at Re = 2300 / 4000', value: `${qc(2300).toFixed(1)} / ${qc(4000).toFixed(1)} mL/s` },
      ],
      charts: [{
        title: 'Velocity profile across the pipe', xLabel: 'r / R', yLabel: 'u / U mean',
        series: [
          { label: 'laminar (parabolic)', points: prof.map((x) => [x, 2 * (1 - x * x)]), style: regime === 'laminar' ? 'line' : 'dashed', color: '--d-fluid' },
          { label: 'turbulent (1/7 power law)', points: prof.map((x) => [x, (60 / 49) * (1 - Math.abs(x)) ** (1 / 7)]), style: regime === 'turbulent' ? 'line' : 'dashed', color: '--d-thermal' },
        ],
      }],
      notes: [regime === 'laminar' ? 'The dye stays a thin, straight filament along the pipe.' : regime === 'transitional' ? 'The filament waves and breaks in bursts (intermittent turbulent puffs).' : 'The dye mixes across the whole pipe within a few diameters.'],
      record: { Re: Re.toFixed(0), regime },
    };
  },
};

// ------------------------------------------------------------------

const heatExchanger: Bench = {
  id: 'bench-heat-exchanger',
  title: 'Heat exchanger',
  instrument: 'Concentric-tube / shell-and-tube trainer with RTDs and flow meters',
  standards: ['TEMA (design practice)'],
  summary: 'Runs hot and cold water through the exchanger, reads four temperatures and two flows, and reduces them to duty, LMTD, U and effectiveness.',
  inputs: [
    { key: 'arr', label: 'Arrangement', value: 0, options: opt(['Counterflow', 'Parallel flow', 'Shell-and-tube, 1 shell pass / 2 tube passes']) },
    { key: 'Th', label: 'Hot inlet', unit: '°C', value: 80, min: 20, max: 200, step: 1 },
    { key: 'Tc', label: 'Cold inlet', unit: '°C', value: 15, min: 1, max: 100, step: 1 },
    { key: 'mh', label: 'Hot flow', unit: 'kg/s', value: 0.3, min: 0.01, max: 20, step: 0.01 },
    { key: 'mc', label: 'Cold flow', unit: 'kg/s', value: 0.4, min: 0.01, max: 20, step: 0.01 },
    { key: 'UA', label: 'Conductance UA', unit: 'W/K', value: 1200, min: 10, max: 1e6, step: 10 },
    { key: 'A', label: 'Heat-transfer area', unit: 'm²', value: 1.2, min: 0.01, max: 1000, step: 0.01 },
    seedInput,
  ],
  run(v) {
    const r = rng(v.seed);
    const cp = 4180;
    const Ch = v.mh * cp, Cc = v.mc * cp, Cmin = Math.min(Ch, Cc), Cmax = Math.max(Ch, Cc), Cr = Cmin / Cmax;
    const NTU = v.UA / Cmin;
    let eps: number;
    if (v.arr === 1) eps = (1 - Math.exp(-NTU * (1 + Cr))) / (1 + Cr);
    else if (v.arr === 2) { const s = Math.sqrt(1 + Cr * Cr), e = Math.exp(-NTU * s); eps = 2 / (1 + Cr + s * (1 + e) / (1 - e)); }
    else eps = Math.abs(1 - Cr) < 1e-9 ? NTU / (1 + NTU) : (1 - Math.exp(-NTU * (1 - Cr))) / (1 - Cr * Math.exp(-NTU * (1 - Cr)));
    const Q = eps * Cmin * (v.Th - v.Tc);
    const Th2 = v.Th - Q / Ch, Tc2 = v.Tc + Q / Cc;
    const read = (t: number) => t + 0.15 * r.gauss();
    const m = { th1: read(v.Th), th2: read(Th2), tc1: read(v.Tc), tc2: read(Tc2) };
    const Qh = Ch * (m.th1 - m.th2), Qc = Cc * (m.tc2 - m.tc1);
    const dT1 = v.arr === 1 ? m.th1 - m.tc1 : m.th1 - m.tc2, dT2 = v.arr === 1 ? m.th2 - m.tc2 : m.th2 - m.tc1;
    const lmtd = Math.abs(dT1 - dT2) < 1e-6 ? dT1 : (dT1 - dT2) / Math.log(dT1 / dT2);
    const Qm = (Qh + Qc) / 2;
    const U = Qm / (v.A * lmtd);
    // Temperature along the exchanger (counterflow shown for the shell-and-tube unit).
    const xs = lin(0, 1, 60);
    let th = v.Th, tc = v.arr === 1 ? v.Tc : Tc2;
    const hot: [number, number][] = [], cold: [number, number][] = [];
    for (let i = 0; i < xs.length; i++) {
      hot.push([xs[i], th]); cold.push([xs[i], tc]);
      const dq = (v.UA / (xs.length - 1)) * (th - tc);
      th -= dq / Ch;
      tc += (v.arr === 1 ? 1 : -1) * (dq / Cc);
    }
    return {
      results: [
        { label: 'Outlet temperatures (hot, cold)', value: `${m.th2.toFixed(1)} °C, ${m.tc2.toFixed(1)} °C` },
        { label: 'Duty Q (hot side / cold side)', value: `${(Qh / 1000).toFixed(2)} / ${(Qc / 1000).toFixed(2)} kW` },
        { label: 'Heat balance error', value: `${((100 * (Qh - Qc)) / Qm).toFixed(1)} %` },
        { label: v.arr === 2 ? 'LMTD (counterflow basis)' : 'LMTD', value: `${lmtd.toFixed(2)} K` },
        { label: v.arr === 2 ? 'U·F from readings' : 'Overall coefficient U', value: `${U.toFixed(0)} W/(m²·K)` },
        { label: 'Effectiveness ε', value: eps.toFixed(3) },
        { label: 'NTU, Cr', value: `${NTU.toFixed(2)}, ${Cr.toFixed(2)}` },
      ],
      charts: [{ title: v.arr === 2 ? 'Temperature along the exchanger (shown as counterflow)' : 'Temperature along the exchanger', xLabel: 'position x / L', yLabel: 'temperature (°C)', series: [{ label: 'hot', points: hot, color: '--d-thermal' }, { label: 'cold', points: cold, color: '--d-electrical' }] }],
      record: { arrangement: ['counterflow', 'parallel', '1-2 shell'][v.arr] ?? '', 'Q (kW)': (Qm / 1000).toFixed(2), 'ε': eps.toFixed(3) },
    };
  },
};

// ------------------------------------------------------------------

const hotfire: Bench = {
  id: 'bench-hotfire',
  title: 'Static hot-fire',
  instrument: 'Rocket test stand: load cell, chamber-pressure transducer, cryogenic and fuel flow meters, liner thermocouple',
  summary: 'Fires the 2 kN LOX/ethanol engine from the Studio example and reduces the run: thrust, Pc, mixture ratio, c* efficiency, Isp, impulse and combustion stability.',
  inputs: [
    { key: 'pox', label: 'LOX tank pressure', unit: 'bar', value: 22, min: 5, max: 40, step: 0.5 },
    { key: 'pfu', label: 'Fuel tank pressure', unit: 'bar', value: 22, min: 5, max: 40, step: 0.5 },
    { key: 'tau', label: 'Combustion time lag', unit: 'ms', value: 2, min: 0.5, max: 12, step: 0.5 },
    { key: 'burn', label: 'Burn duration', unit: 's', value: 3, min: 1, max: 6, step: 0.5 },
  ],
  run(v) {
    const def = SCENES.find((s) => s.id === 'rocket-engine')!;
    const inst = def.create();
    const comp = (id: string) => inst.components.find((c) => c.id === id)!;
    const set = (id: string, key: string, value: number) => { const p = comp(id).params.find((x) => x.key === key); if (p) p.value = value; };
    set('TO', 'p', v.pox * 1e5); set('TF', 'p', v.pfu * 1e5); set('E1', 'tau', v.tau / 1000);
    set('VO', 'close', 0.5 + v.burn); set('VF', 'close', 0.55 + v.burn);
    const E = comp('E1') as unknown as { state: { pc: number; thrust: number; mdotOx: number; mdotFu: number; burning: boolean; impulse: number }; params: { key: string; value: number }[] };
    const LC = comp('LC') as unknown as { force(): number };
    const W = comp('W1');
    const sim = new Simulator(inst.nodes, inst.elements, { h: def.h, method: def.method, initial: inst.initial });
    const t: number[] = [], pc: number[] = [], F: number[] = [], ox: number[] = [], fu: number[] = [], Tw: number[] = [];
    const end = 0.55 + v.burn + 0.6;
    let next = 0;
    while (sim.t < end) {
      if (!sim.step()) break;
      if (sim.t >= next) {
        t.push(sim.t); pc.push(E.state.pc / 1e5); F.push(LC.force()); ox.push(E.state.mdotOx); fu.push(E.state.mdotFu); Tw.push(sim.effort(W.ports[0].node) - 273.15);
        next += 0.001;
      }
    }
    const w0 = 1.0, w1 = 0.45 + v.burn;
    const idx = t.map((x, i) => (x >= w0 && x <= w1 ? i : -1)).filter((i) => i >= 0);
    const avg = (a: number[]) => idx.reduce((s, i) => s + a[i], 0) / Math.max(1, idx.length);
    const Pc = avg(pc), Fm = avg(F), mo = avg(ox), mf = avg(fu);
    const At = (Math.PI * E.params.find((p) => p.key === 'Dt')!.value ** 2) / 4;
    const cstarTh = E.params.find((p) => p.key === 'cstar')!.value;
    const mr = mo / mf;
    const cstar = (Pc * 1e5 * At) / (mo + mf);
    const x = mr / E.params.find((p) => p.key === 'mrOpt')!.value - 1;
    const cstarIdeal = cstarTh * Math.max(0.55, 1 - 0.16 * x * x);
    const isp = Fm / ((mo + mf) * 9.80665);
    const lo = Math.min(...idx.map((i) => pc[i])), hi = Math.max(...idx.map((i) => pc[i]));
    const rough = (100 * (hi - lo)) / Math.max(1e-6, Pc);
    // Pc spectrum over the steady window.
    const seg = idx.map((i) => pc[i] - Pc);
    const N = 2 ** Math.floor(Math.log2(Math.max(64, seg.length)));
    const win = windowFn(0, N);
    const mag = fftMag(seg.slice(0, N).map((s, i) => s * win[i]));
    const df = 1 / (N * 0.001);
    let kmax = 1;
    for (let k = 2; k < mag.length; k++) if (mag[k] > mag[kmax]) kmax = k;
    const spec = mag.map((m, k) => [k * df, 20 * Math.log10(Math.max(1e-9, (2 * m) / (N * 0.5)))] as [number, number]).filter(([f]) => f > 0 && f <= 500);
    const peakT = Math.max(...Tw);
    const stable = rough < 5;
    const pass = stable && peakT < 450 && Fm > 0;
    const total = E.state.impulse;
    const step = Math.max(1, Math.floor(t.length / 900));
    const ds = <T>(a: T[]) => a.filter((_, i) => i % step === 0);
    const tt = ds(t);
    return {
      results: [
        { label: 'Steady thrust (load cell)', value: `${Fm.toFixed(0)} N` },
        { label: 'Chamber pressure', value: `${Pc.toFixed(2)} bar` },
        { label: 'LOX / fuel flow', value: `${mo.toFixed(3)} / ${mf.toFixed(3)} kg/s` },
        { label: 'Mixture ratio O/F', value: mr.toFixed(2) },
        { label: 'Measured c* = Pc·At/ṁ', value: `${cstar.toFixed(0)} m/s (η c* ${((100 * cstar) / cstarIdeal).toFixed(1)} %)` },
        { label: 'Specific impulse', value: `${isp.toFixed(0)} s` },
        { label: 'Total impulse', value: `${total.toFixed(0)} N·s` },
        { label: 'Pc roughness (peak-to-peak)', value: `${rough.toFixed(1)} %${stable ? '' : ` · dominant ${(kmax * df).toFixed(0)} Hz`}` },
        { label: 'Peak liner temperature', value: `${peakT.toFixed(0)} °C` },
      ],
      charts: [
        { title: 'Chamber pressure', xLabel: 'time (s)', yLabel: 'Pc (bar)', series: [{ label: 'Pc', points: tt.map((x, i) => [x, ds(pc)[i]]), color: '--d-fluid' }] },
        { title: 'Load-cell thrust', xLabel: 'time (s)', yLabel: 'thrust (N)', series: [{ label: 'load cell', points: tt.map((x, i) => [x, ds(F)[i]]), color: '--d-translational' }] },
        { title: 'Propellant flow (flow meters)', xLabel: 'time (s)', yLabel: 'mass flow (kg/s)', series: [{ label: 'LOX', points: tt.map((x, i) => [x, ds(ox)[i]]), color: '--d-electrical' }, { label: 'ethanol', points: tt.map((x, i) => [x, ds(fu)[i]]), color: '--warn' }] },
        { title: 'Pc spectrum, steady window', xLabel: 'frequency (Hz)', yLabel: 'amplitude (dB re 1 bar)', series: [{ label: 'Pc FFT (Hann)', points: spec, color: '--d-fluid' }] },
      ],
      verdict: { pass, text: !stable ? `Unstable: ${rough.toFixed(0)} % Pc oscillation near ${(kmax * df).toFixed(0)} Hz (chug). Raise injector Δp or shorten the combustion lag.` : peakT >= 450 ? `Liner reached ${peakT.toFixed(0)} °C, above the 450 °C limit.` : 'Stable combustion (Pc roughness under 5 %) and the liner stayed cool.' },
      notes: ['Readings sampled at 1 kHz. Steady values are averaged from 1.0 s to 0.1 s before shutdown.'],
      record: { 'F (N)': Fm.toFixed(0), 'Pc (bar)': Pc.toFixed(2), 'O/F': mr.toFixed(2), 'Isp (s)': isp.toFixed(0), 'rough (%)': rough.toFixed(1) },
    };
  },
};

// ------------------------------------------------------------------

const MODELS = ['Sphere', 'Circular cylinder (2-D)', 'NACA 0012 airfoil', 'Flat plate normal to flow'];

function sphereCd(Re: number) {
  return 24 / Re + (2.6 * (Re / 5)) / (1 + (Re / 5) ** 1.52) + (0.411 * (Re / 263000) ** -7.94) / (1 + (Re / 263000) ** -8) + (0.25 * (Re / 1e6)) / (1 + Re / 1e6);
}
function cylinderCd(Re: number) {
  const sub = 1.18 + 6.8 / Re ** 0.89 + 1.96 / Re ** 0.5 - (0.0004 * Re) / (1 + 3.64e-7 * Re * Re);
  const base = Math.max(1.0, Re < 2e5 ? sub : 1.2);
  if (Re < 2e5) return base;
  const s = Math.min(1, (Re - 2e5) / 3e5);
  return base * (1 - s) + 0.3 * s;
}
function airfoil(alphaDeg: number, Re: number) {
  const as = 12 + 2 * Math.min(1, Re / 1e6);
  const a = Math.abs(alphaDeg), sg = Math.sign(alphaDeg);
  const clLin = 2 * Math.PI * 0.95 * (a * Math.PI) / 180;
  const clMax = 2 * Math.PI * 0.95 * (as * Math.PI) / 180;
  const cl = a <= as ? clLin : clMax * (0.65 + 0.35 * Math.exp(-(a - as) / 3));
  const cd0 = 2 * (0.074 / Re ** 0.2) * 1.2;
  const cd = cd0 + 0.008 * cl * cl + (a > as ? 0.03 * (a - as) : 0);
  return { cl: sg * cl, cd };
}

const windTunnel: Bench = {
  id: 'bench-wind-tunnel',
  title: 'Wind tunnel',
  instrument: 'Low-speed closed-circuit tunnel, 3-component balance and PIV wake survey',
  summary: 'Puts a model in the test section, reads lift and drag from the balance, and checks drag with a PIV momentum-deficit survey of the wake.',
  inputs: [
    { key: 'model', label: 'Model', value: 2, options: opt(MODELS) },
    { key: 'size', label: 'Diameter or chord', unit: 'mm', value: 150, min: 5, max: 1000, step: 1 },
    { key: 'span', label: 'Span (2-D models)', unit: 'mm', value: 300, min: 10, max: 2000, step: 5 },
    { key: 'V', label: 'Airspeed', unit: 'm/s', value: 25, min: 1, max: 80, step: 0.5 },
    { key: 'aoa', label: 'Angle of attack (airfoil)', unit: '°', value: 6, min: -10, max: 25, step: 0.5 },
    { key: 'T', label: 'Air temperature', unit: '°C', value: 20, min: -10, max: 45, step: 1 },
    seedInput,
  ],
  run(v) {
    const r = rng(v.seed);
    const TK = v.T + 273.15;
    const rho = 101325 / (287.05 * TK);
    const mu = (1.458e-6 * TK ** 1.5) / (TK + 110.4);
    const c = v.size / 1000, b = v.span / 1000;
    const Re = (rho * v.V * c) / mu;
    const q = 0.5 * rho * v.V * v.V;
    const m = v.model;
    let S: number, Cd: number, Cl = 0;
    if (m === 0) { S = (Math.PI * c * c) / 4; Cd = sphereCd(Re); }
    else if (m === 1) { S = c * b; Cd = cylinderCd(Re); }
    else if (m === 2) { S = c * b; const a = airfoil(v.aoa, Re); Cd = a.cd; Cl = a.cl; }
    else { S = c * b; Cd = 1.98; }
    const D = q * S * Cd * (1 + 0.005 * r.gauss()) + 0.002 * r.gauss();
    const L = q * S * Cl * (1 + 0.005 * r.gauss()) + 0.002 * r.gauss();
    // PIV wake: Gaussian velocity deficit whose momentum integral matches the drag.
    const width = m === 2 ? 0.08 * c + 0.02 * c * Math.abs(v.aoa) : 0.6 * c;
    const ys = lin(-4 * width, 4 * width, 81);
    const amp = (Cd * c) / (2 * width * Math.sqrt(Math.PI));
    const prof = ys.map((y) => [y * 1000, 1 - Math.min(0.95, amp) * Math.exp(-((y / width) ** 2)) + 0.004 * r.gauss()] as [number, number]);
    let integ = 0;
    for (let i = 1; i < prof.length; i++) {
      const u0 = prof[i - 1][1], u1 = prof[i][1], dy = (prof[i][0] - prof[i - 1][0]) / 1000;
      integ += 0.5 * (u0 * (1 - u0) + u1 * (1 - u1)) * dy;
    }
    const CdWake = (2 * integ) / c;
    const charts: Chart[] = [];
    if (m === 2) {
      const al = lin(-6, 20, 53);
      charts.push({ title: 'Lift and drag polars', xLabel: 'angle of attack (°)', yLabel: 'coefficient', series: [{ label: 'Cl', points: al.map((x) => [x, airfoil(x, Re).cl]) }, { label: 'Cd × 10', points: al.map((x) => [x, 10 * airfoil(x, Re).cd]), color: '--d-thermal' }, { label: 'this run', points: [[v.aoa, L / (q * S)]], style: 'points', color: '--d-rotational' }] });
    } else if (m < 3) {
      const res = logspace(1e3, 1e6, 80);
      charts.push({ title: m === 0 ? 'Sphere drag against Reynolds number' : 'Cylinder drag against Reynolds number', xLabel: 'Re', yLabel: 'Cd', xLog: true, yLog: true, series: [{ label: 'reference curve', points: res.map((x) => [x, m === 0 ? sphereCd(x) : cylinderCd(x)]) }, { label: 'this run', points: [[Re, D / (q * S)]], style: 'points', color: '--d-thermal' }] });
    }
    charts.push({ title: 'PIV wake survey, one chord downstream', xLabel: 'cross-stream position (mm)', yLabel: 'u / U∞', series: [{ label: 'PIV', points: prof, color: '--d-fluid' }] });
    return {
      results: [
        { label: 'Reynolds number', value: Re.toExponential(3) },
        { label: 'Dynamic pressure q', value: `${q.toFixed(1)} Pa` },
        { label: 'Balance drag / lift', value: `${D.toFixed(3)} N / ${L.toFixed(3)} N` },
        { label: 'Cd (balance)', value: (D / (q * S)).toFixed(4) },
        ...(m === 2 ? [{ label: 'Cl, L/D', value: `${(L / (q * S)).toFixed(3)}, ${(L / Math.max(1e-9, D)).toFixed(1)}` }] : []),
        { label: 'Cd from PIV momentum deficit', value: CdWake.toFixed(4) },
      ],
      charts,
      notes: m === 2 && Math.abs(v.aoa) > 12 ? ['Past about 12–14° the boundary layer separates: lift falls and drag climbs (stall).'] : m === 1 && Re > 2e5 ? ['Above Re ≈ 2×10⁵ the boundary layer turns turbulent before separating and drag drops (drag crisis).'] : undefined,
      record: { model: MODELS[m] ?? '', Re: Re.toExponential(2), Cd: (D / (q * S)).toFixed(4), Cl: (L / (q * S)).toFixed(3) },
    };
  },
};

// ------------------------------------------------------------------

const concrete: Bench = {
  id: 'bench-concrete',
  title: 'Concrete cylinder compression',
  instrument: 'Compression machine (UTM) with spherically seated platen, capping or pads',
  standards: ['ASTM C39/C39M', 'ACI 318-19 §26.12.3'],
  summary: 'Crushes 28-day cylinders, forms strength tests from pairs (or triples), and applies the ACI 318 acceptance rules for f′c.',
  inputs: [
    { key: 'fc', label: 'Specified strength f′c', unit: 'MPa', value: 30, min: 15, max: 80, step: 1 },
    { key: 'size', label: 'Cylinder size', value: 150, options: [{ value: 150, label: '150 × 300 mm (2 per test)' }, { value: 100, label: '100 × 200 mm (3 per test)' }] },
    { key: 'tests', label: 'Number of strength tests', value: 15, min: 3, max: 60, step: 1 },
    { key: 'over', label: 'Mix over-design (mean − f′c)', unit: 'MPa', value: 6, min: -10, max: 20, step: 0.5 },
    { key: 'sd', label: 'Batch-to-batch standard deviation', unit: 'MPa', value: 3.5, min: 0.5, max: 10, step: 0.1 },
    seedInput,
  ],
  run(v) {
    const r = rng(v.seed);
    const per = v.size === 150 ? 2 : 3;
    const A = (Math.PI * v.size * v.size) / 4;
    const tests = Array.from({ length: v.tests }, () => {
      const batch = v.fc + v.over + v.sd * r.gauss();
      const cyl = Array.from({ length: per }, () => batch * (1 + 0.03 * r.gauss()));
      return cyl.reduce((a, b) => a + b, 0) / per;
    });
    const mean = tests.reduce((a, b) => a + b, 0) / tests.length;
    const sd = Math.sqrt(tests.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, tests.length - 1));
    const avg3 = tests.map((_, i) => (i >= 2 ? (tests[i] + tests[i - 1] + tests[i - 2]) / 3 : NaN));
    const min3 = Math.min(...avg3.filter(Number.isFinite));
    const minTest = Math.min(...tests);
    const low = v.fc <= 35 ? v.fc - 3.5 : 0.9 * v.fc;
    const ok1 = !(min3 < v.fc), ok2 = minTest >= low;
    const k = tests.length >= 30 ? 1 : tests.length >= 25 ? 1.03 : tests.length >= 20 ? 1.08 : tests.length >= 15 ? 1.16 : NaN;
    const s = sd * (Number.isFinite(k) ? k : 1);
    const fcr = Number.isFinite(k) ? (v.fc <= 35 ? Math.max(v.fc + 1.34 * s, v.fc + 2.33 * s - 3.5) : Math.max(v.fc + 1.34 * s, 0.9 * v.fc + 2.33 * s)) : v.fc <= 21 ? v.fc + 7 : v.fc <= 35 ? v.fc + 8.3 : 1.1 * v.fc + 5;
    const Ec = 4700 * Math.sqrt(mean), e0 = (2 * mean) / Ec;
    const ss = lin(0, 1.6 * e0, 60).map((e) => [e * 1000, e <= e0 ? mean * (2 * (e / e0) - (e / e0) ** 2) : mean * (1 - 0.15 * ((e - e0) / (0.0038 - e0)))] as [number, number]);
    return {
      results: [
        { label: 'Mean strength', value: `${mean.toFixed(1)} MPa (${tests.length} tests of ${per} cylinders)` },
        { label: 'Standard deviation, CoV', value: `${sd.toFixed(2)} MPa, ${((100 * sd) / mean).toFixed(1)} %` },
        { label: 'Lowest test / lowest 3-test average', value: `${minTest.toFixed(1)} / ${min3.toFixed(1)} MPa` },
        { label: 'Rule 1: every 3-test average ≥ f′c', value: ok1 ? 'met' : 'not met' },
        { label: `Rule 2: no test below ${low.toFixed(1)} MPa`, value: ok2 ? 'met' : 'not met' },
        { label: 'Required average strength f′cr', value: `${fcr.toFixed(1)} MPa${Number.isFinite(k) ? ` (s × ${k})` : ' (fewer than 15 tests: table values)'}` },
        { label: 'Failure load at mean strength', value: `${((mean * A) / 1000).toFixed(0)} kN` },
      ],
      charts: [
        { title: 'Strength tests', xLabel: 'test number', yLabel: 'strength (MPa)', series: [{ label: 'test', points: tests.map((x, i) => [i + 1, x]), style: 'bars', color: '--text-2' }, { label: '3-test average', points: avg3.map((x, i) => [i + 1, x] as [number, number]).filter(([, y]) => Number.isFinite(y)), color: '--d-electrical' }], marks: [{ y: v.fc, label: `f′c ${v.fc}` }, { y: low, label: `low limit ${low.toFixed(1)}` }] },
        { title: 'Cylinder stress–strain (Hognestad)', xLabel: 'strain (‰)', yLabel: 'stress (MPa)', series: [{ label: 'mean cylinder', points: ss, color: '--d-thermal' }] },
      ],
      verdict: { pass: ok1 && ok2, text: ok1 && ok2 ? `Concrete accepted for f′c = ${v.fc} MPa under ACI 318-19 §26.12.3.1.` : 'Strength is not acceptable: investigate low-strength results (cores per ACI 318 §26.12.6).' },
      record: { "f'c (MPa)": String(v.fc), 'mean (MPa)': mean.toFixed(1), accepted: ok1 && ok2 ? 'yes' : 'no' },
    };
  },
};

// ------------------------------------------------------------------

/** Eigenvalues and vectors of a symmetric 3×3 matrix by cyclic Jacobi rotation. */
function jacobi3(A0: number[][]): { vals: number[]; vecs: number[][] } {
  const A = A0.map((r) => r.slice());
  const V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 50; sweep++) {
    for (let p = 0; p < 2; p++) for (let q = p + 1; q < 3; q++) {
      if (Math.abs(A[p][q]) < 1e-14) continue;
      const th = (A[q][q] - A[p][p]) / (2 * A[p][q]);
      const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++) { const akp = A[k][p], akq = A[k][q]; A[k][p] = c * akp - s * akq; A[k][q] = s * akp + c * akq; }
      for (let k = 0; k < 3; k++) { const apk = A[p][k], aqk = A[q][k]; A[p][k] = c * apk - s * aqk; A[q][k] = s * apk + c * aqk; }
      for (let k = 0; k < 3; k++) { const vkp = V[k][p], vkq = V[k][q]; V[k][p] = c * vkp - s * vkq; V[k][q] = s * vkp + c * vkq; }
    }
  }
  const order = [0, 1, 2].sort((i, j) => A[i][i] - A[j][j]);
  return { vals: order.map((i) => A[i][i]), vecs: order.map((i) => [V[0][i], V[1][i], V[2][i]]) };
}

const shakeTable: Bench = {
  id: 'bench-shake-table',
  title: 'Shake table, 3-story frame',
  instrument: 'Uniaxial shake table with accelerometers on each floor and LVDT drift gauges',
  standards: ['ASCE 7-22 §12.12 (story drift limits)'],
  summary: 'Finds the natural frequencies and mode shapes of a 3-story shear-frame model, drives it with a sine, a sweep or a synthetic earthquake, and checks inter-story drift and story shear against yield.',
  inputs: [
    { key: 'm', label: 'Floor mass', unit: 'kg', value: 5, min: 0.5, max: 500, step: 0.5 },
    { key: 'k', label: 'Story stiffness', unit: 'kN/m', value: 30, min: 0.5, max: 5000, step: 0.5 },
    { key: 'h', label: 'Story height', unit: 'mm', value: 300, min: 50, max: 4000, step: 10 },
    { key: 'zeta', label: 'Damping ratio', unit: '%', value: 2, min: 0.2, max: 20, step: 0.1 },
    { key: 'input', label: 'Table motion', value: 2, options: opt(['Sine at set frequency', 'Sine sweep 1–30 Hz', 'Synthetic earthquake (filtered noise)']) },
    { key: 'pga', label: 'Peak table acceleration', unit: 'g', value: 0.3, min: 0.01, max: 2, step: 0.01 },
    { key: 'f', label: 'Sine frequency', unit: 'Hz', value: 5, min: 0.2, max: 50, step: 0.1 },
    { key: 'vy', label: 'Story yield shear (plastic hinges)', unit: 'N', value: 600, min: 1, max: 1e7, step: 10 },
    seedInput,
  ],
  run(v) {
    const r = rng(v.seed);
    const m = v.m, k = v.k * 1000, zeta = v.zeta / 100, h = v.h / 1000;
    const K = [[2 * k, -k, 0], [-k, 2 * k, -k], [0, -k, k]];
    const { vals, vecs } = jacobi3(K.map((row) => row.map((x) => x / m)));
    const w = vals.map((x) => Math.sqrt(Math.max(x, 0)));
    const freqs = w.map((x) => x / (2 * Math.PI));
    const a0 = (2 * zeta * w[0] * w[1]) / (w[0] + w[1]), a1 = (2 * zeta) / (w[0] + w[1]);
    const C = K.map((row, i) => row.map((x, j) => a1 * x + (i === j ? a0 * m : 0)));
    const dt = 0.002, T = v.input === 1 ? 30 : 15, steps = Math.round(T / dt);
    const g = 9.80665;
    // Table acceleration history.
    const ag: number[] = new Array(steps).fill(0);
    if (v.input === 0) for (let i = 0; i < steps; i++) { const t = i * dt; ag[i] = Math.sin(2 * Math.PI * v.f * t) * Math.min(1, t / 1); }
    else if (v.input === 1) { const k1 = Math.log(30 / 1) / T; for (let i = 0; i < steps; i++) { const t = i * dt; ag[i] = Math.sin((2 * Math.PI * 1 * (Math.exp(k1 * t) - 1)) / k1); } }
    else {
      const wg = 15, zg = 0.6; let x = 0, xd = 0;
      for (let i = 0; i < steps; i++) {
        const t = i * dt, wn = r.gauss() / Math.sqrt(dt);
        const xdd = -2 * zg * wg * xd - wg * wg * x - wn;
        xd += xdd * dt; x += xd * dt;
        const env = t < 2 ? (t / 2) ** 2 : t < 8 ? 1 : Math.exp(-0.4 * (t - 8));
        ag[i] = env * (-2 * zg * wg * xd - wg * wg * x);
      }
    }
    const peak = Math.max(...ag.map(Math.abs)) || 1;
    for (let i = 0; i < steps; i++) ag[i] = (ag[i] / peak) * v.pga * g;
    // Newmark average acceleration (γ = 1/2, β = 1/4).
    const be = 0.25, ga = 0.5;
    const Kh = K.map((row, i) => row.map((x, j) => x + (ga / (be * dt)) * C[i][j] + (i === j ? m / (be * dt * dt) : 0)));
    const solve = (A: number[][], b: number[]) => {
      const M = A.map((row, i) => [...row, b[i]]);
      for (let c = 0; c < 3; c++) { let p = c; for (let rr = c + 1; rr < 3; rr++) if (Math.abs(M[rr][c]) > Math.abs(M[p][c])) p = rr; [M[c], M[p]] = [M[p], M[c]]; for (let rr = 0; rr < 3; rr++) if (rr !== c) { const f = M[rr][c] / M[c][c]; for (let cc = c; cc < 4; cc++) M[rr][cc] -= f * M[c][cc]; } }
      return [0, 1, 2].map((i) => M[i][3] / M[i][i]);
    };
    let u = [0, 0, 0], ud = [0, 0, 0], udd = [0, 0, 0];
    const roof: [number, number][] = [];
    const drift = [0, 0, 0], shear = [0, 0, 0];
    let baseShear = 0;
    for (let i = 1; i < steps; i++) {
      const p = [-m * ag[i], -m * ag[i], -m * ag[i]];
      const rhs = p.map((pj, a) => pj + [0, 1, 2].reduce((s, b2) => s + (a === b2 ? m : 0) * (u[b2] / (be * dt * dt) + ud[b2] / (be * dt) + (1 / (2 * be) - 1) * udd[b2]) + C[a][b2] * ((ga / (be * dt)) * u[b2] + (ga / be - 1) * ud[b2] + dt * (ga / (2 * be) - 1) * udd[b2]), 0));
      const un = solve(Kh, rhs);
      const uddn = un.map((x, j) => (x - u[j]) / (be * dt * dt) - ud[j] / (be * dt) - (1 / (2 * be) - 1) * udd[j]);
      const udn = ud.map((x, j) => x + dt * ((1 - ga) * udd[j] + ga * uddn[j]));
      u = un; ud = udn; udd = uddn;
      const rel = [u[0], u[1] - u[0], u[2] - u[1]];
      rel.forEach((d, j) => { drift[j] = Math.max(drift[j], Math.abs(d) / h); shear[j] = Math.max(shear[j], Math.abs(k * d)); });
      baseShear = Math.max(baseShear, Math.abs(k * u[0]));
      if (i % 10 === 0) roof.push([i * dt, u[2] * 1000]);
    }
    const maxDrift = Math.max(...drift) * 100;
    const hinges = shear.map((s, j) => (s > v.vy ? j + 1 : 0)).filter(Boolean);
    const pass = maxDrift <= 2 && !hinges.length;
    const norm = (vec: number[]) => { const top = vec[2] || 1; return vec.map((x) => x / top); };
    return {
      results: [
        { label: 'Natural frequencies f₁, f₂, f₃', value: freqs.map((f) => `${f.toFixed(2)} Hz`).join(', ') },
        { label: 'Peak roof displacement (relative to table)', value: `${Math.max(...roof.map((p) => Math.abs(p[1]))).toFixed(2)} mm` },
        ...drift.map((d, j) => ({ label: `Story ${j + 1} peak drift ratio`, value: `${(d * 100).toFixed(3)} %` })),
        { label: 'Peak base shear', value: `${baseShear.toFixed(0)} N (${((100 * baseShear) / (3 * m * g)).toFixed(0)} % of weight)` },
        { label: 'Story shears vs yield', value: shear.map((s) => `${s.toFixed(0)} N`).join(' · ') + ` (yield ${v.vy} N)` },
      ],
      charts: [
        { title: 'Roof displacement', xLabel: 'time (s)', yLabel: 'displacement (mm)', series: [{ label: 'roof', points: roof, color: '--d-translational' }] },
        { title: 'Peak inter-story drift', xLabel: 'story', yLabel: 'drift ratio (%)', series: [{ label: 'drift', points: drift.map((d, j) => [j + 1, d * 100]), style: 'bars', color: '--d-translational' }], marks: [{ y: 2, label: '2 % limit' }] },
        { title: 'Mode shapes', xLabel: 'normalised displacement', yLabel: 'floor', series: vecs.map((vec, i) => ({ label: `mode ${i + 1} (${freqs[i].toFixed(1)} Hz)`, points: [[0, 0], ...norm(vec).map((x, j) => [x, j + 1] as [number, number])] })) },
      ],
      verdict: { pass, text: hinges.length ? `Story shear exceeded yield at story ${hinges.join(', ')}: plastic hinges would form in those columns.` : maxDrift > 2 ? `Peak drift ${maxDrift.toFixed(2)} % exceeds the 2 % limit.` : `Elastic response; peak drift ${maxDrift.toFixed(2)} % is within 2 %.` },
      notes: [v.input === 2 ? 'The synthetic record is Kanai–Tajimi filtered noise with a build-up, strong-motion and decay envelope, scaled to the peak acceleration. It is not a recorded earthquake.' : 'Resonance is strongest when the sine frequency is near f₁.', 'Rayleigh damping fitted at modes 1 and 2; Newmark average-acceleration integration at 2 ms.'],
      record: { 'f1 (Hz)': freqs[0].toFixed(2), 'drift max (%)': maxDrift.toFixed(2), hinges: hinges.join(' ') || 'none' },
    };
  },
};

// ------------------------------------------------------------------

const FUELS = [
  { name: 'Benzoic acid (calibration standard)', gcv: 26.454, H: 0.0495 },
  { name: 'Bituminous coal', gcv: 30.2, H: 0.05 },
  { name: 'Diesel fuel', gcv: 45.5, H: 0.135 },
  { name: 'Ethanol', gcv: 29.7, H: 0.131 },
  { name: 'Dry wood', gcv: 19.0, H: 0.06 },
];

const bomb: Bench = {
  id: 'bench-bomb-calorimeter',
  title: 'Bomb calorimeter',
  instrument: 'Isoperibol oxygen bomb calorimeter with 0.001 K thermometer',
  standards: ['ASTM D240', 'ASTM D5865', 'ISO 1928'],
  summary: 'Burns a weighed sample in oxygen, reads the water temperature rise, applies the Dickinson drift correction and fuse/acid corrections, and computes the gross calorific value.',
  inputs: [
    { key: 'fuel', label: 'Sample', value: 1, options: opt(FUELS.map((f) => f.name)) },
    { key: 'mass', label: 'Sample mass', unit: 'g', value: 1.0, min: 0.2, max: 1.5, step: 0.01 },
    { key: 'W', label: 'Energy equivalent W', unit: 'J/K', value: 10150, min: 5000, max: 20000, step: 10 },
    { key: 'fuse', label: 'Fuse wire burned', unit: 'cm', value: 8, min: 0, max: 12, step: 0.1 },
    { key: 'acid', label: 'Acid correction (titration)', unit: 'J', value: 40, min: 0, max: 300, step: 1 },
    seedInput,
  ],
  run(v) {
    const f = FUELS[v.fuel] ?? FUELS[0];
    const r = rng(v.seed);
    const gcvTrue = f.gcv * (1 + 0.004 * r.gauss());
    const e1 = 9.6 * v.fuse;
    const dTtrue = (v.mass * gcvTrue * 1000 + e1 + v.acid) / v.W;
    const T0 = 24.5, r1 = 0.002, r2 = -0.004, a = 5, tau = 1.1;
    const Tof = (t: number) => (t <= a ? T0 + r1 * t : T0 + r1 * a + dTtrue * (1 - Math.exp(-(t - a) / tau)) + r2 * Math.max(0, t - a - 2));
    const pts = lin(0, 20, 41).map((t) => [t, Math.round((Tof(t) + 0.0005 * r.gauss()) * 1000) / 1000] as [number, number]);
    const at = (t: number) => pts.reduce((best, p) => (Math.abs(p[0] - t) < Math.abs(best[0] - t) ? p : best))[1];
    const Ta = at(a);
    const c = 14;
    const Tc = at(c);
    const b = pts.find(([t, T]) => t > a && T >= Ta + 0.6 * (Tc - Ta))![0];
    const dT = Tc - Ta - r1 * (b - a) - r2 * (c - b);
    const isCal = v.fuel === 0;
    const W = isCal ? (v.mass * 26454 + e1 + v.acid) / dT : v.W;
    const gcv = isCal ? f.gcv : (v.W * dT - e1 - v.acid) / v.mass / 1000;
    const ncv = gcv - 2.442 * 9 * f.H;
    return {
      results: [
        { label: 'Corrected temperature rise ΔT', value: `${dT.toFixed(4)} K` },
        { label: 'Dickinson times a, b, c', value: `${a}, ${b}, ${c} min` },
        { label: 'Fuse correction e₁', value: `${e1.toFixed(0)} J` },
        ...(isCal
          ? [{ label: 'Energy equivalent W (calibration)', value: `${W.toFixed(0)} J/K` }]
          : [
              { label: 'Gross calorific value', value: `${gcv.toFixed(2)} MJ/kg (reference ${f.gcv})` },
              { label: 'Net calorific value (est.)', value: `${ncv.toFixed(2)} MJ/kg` },
              { label: 'Error against reference', value: `${((100 * (gcv - f.gcv)) / f.gcv).toFixed(2)} %` },
            ]),
      ],
      charts: [{ title: 'Calorimeter temperature', xLabel: 'time (min)', yLabel: 'temperature (°C)', series: [{ label: 'thermometer', points: pts, style: 'points', color: '--d-thermal' }, { label: 'trend', points: pts, color: '--d-thermal' }], marks: [{ x: a, label: 'a' }, { x: b, label: 'b' }, { x: c, label: 'c' }] }],
      notes: ['ΔT = Tc − Ta − r₁(b − a) − r₂(c − b), with r₁ and r₂ the pre- and post-period drift rates and b the time at 60 % of the rise.'],
      record: { sample: f.name, 'ΔT (K)': dT.toFixed(4), [isCal ? 'W (J/K)' : 'GCV (MJ/kg)']: isCal ? W.toFixed(0) : gcv.toFixed(2) },
    };
  },
};

// ------------------------------------------------------------------

const UNKNOWNS = [
  { name: 'Toluene', I: 763, mz: '91, 92' },
  { name: 'n-Butyl acetate', I: 790, mz: '43, 56, 73' },
  { name: 'Ethylbenzene', I: 855, mz: '91, 106' },
  { name: 'p-Xylene', I: 865, mz: '91, 106' },
  { name: 'Limonene', I: 1030, mz: '68, 93, 136' },
  { name: 'Naphthalene', I: 1182, mz: '128' },
];

const gc: Bench = {
  id: 'bench-gc-retention',
  title: 'GC retention index',
  instrument: 'Gas chromatograph with DB-1 (100 % PDMS) column, FID or MS detector',
  standards: ['ASTM D6730 (detailed hydrocarbon analysis)'],
  summary: 'Runs an n-alkane ladder and an unknown isothermally, then brackets the unknown between alkanes to compute its Kovats retention index.',
  inputs: [
    { key: 'u', label: 'Unknown', value: 2, options: opt(UNKNOWNS.map((x) => x.name)) },
    { key: 'T', label: 'Column temperature', unit: '°C', value: 100, min: 50, max: 220, step: 1 },
    { key: 't0', label: 'Dead time t₀', unit: 'min', value: 1.2, min: 0.3, max: 5, step: 0.05 },
    { key: 'N', label: 'Plate number', value: 60000, min: 5000, max: 300000, step: 1000 },
    seedInput,
  ],
  run(v) {
    const r = rng(v.seed);
    const u = UNKNOWNS[v.u] ?? UNKNOWNS[0];
    const TK = v.T + 273.15;
    const slope = 0.29 * (373.15 / TK) ** 1.6;
    const icpt = -2.6 - slope * 1.2;
    const k = (I: number) => 10 ** (icpt + slope * (I / 100));
    const tr = (I: number) => v.t0 * (1 + k(I));
    const Ix = u.I + 0.08 * (v.T - 100) + 1.2 * r.gauss();
    const alk = [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].map((c) => ({ c, t: tr(c * 100) * (1 + 0.0005 * r.gauss()) }));
    const tx = tr(Ix);
    const n0 = alk.filter((a) => a.t < tx).pop(), n1 = alk.find((a) => a.t > tx);
    const adj = (t: number) => Math.log10(t - v.t0);
    const I = n0 && n1 ? 100 * (n0.c + (adj(tx) - adj(n0.t)) / (adj(n1.t) - adj(n0.t))) : NaN;
    const tmax = Math.min(60, (n1?.t ?? tx) * 1.3 + 1);
    const peaks = [...alk.filter((a) => a.t < tmax).map((a) => ({ t: a.t, h: 1 })), { t: tx, h: 0.7 }];
    const ts = lin(0, tmax, 900);
    const sig = ts.map((t) => [t, peaks.reduce((s, p) => { const sg = p.t / Math.sqrt(v.N); return s + p.h * Math.exp(-0.5 * ((t - p.t) / sg) ** 2); }, 0) + 0.004 * r.gauss()] as [number, number]);
    const dI = I - u.I;
    const ok = Math.abs(dI) <= 10;
    return {
      results: [
        { label: 'Unknown retention time t_R', value: `${tx.toFixed(3)} min (adjusted ${(tx - v.t0).toFixed(3)})` },
        { label: 'Bracketing alkanes', value: n0 && n1 ? `C${n0.c} at ${n0.t.toFixed(3)} min, C${n1.c} at ${n1.t.toFixed(3)} min` : 'outside the ladder' },
        { label: 'Kovats index I', value: Number.isFinite(I) ? I.toFixed(0) : '—' },
        { label: 'Literature I (DB-1)', value: `${u.I} (ΔI ${Number.isFinite(dI) ? dI.toFixed(0) : '—'})` },
        { label: 'MS base / major ions m/z', value: u.mz },
      ],
      charts: [{ title: 'Chromatogram', xLabel: 'time (min)', yLabel: 'detector signal', series: [{ label: 'signal', points: sig, color: '--d-electrical' }], marks: [{ x: tx, label: u.name }] }],
      verdict: { pass: ok, text: ok ? `Index ${I.toFixed(0)} matches ${u.name} within 10 units; confirm with the mass spectrum.` : 'Index does not match the library value within 10 units.' },
      notes: ['I = 100·[n + (log t′x − log t′n) / (log t′n+1 − log t′n)], with t′ = t_R − t₀ (isothermal Kovats).'],
      record: { unknown: u.name, I: Number.isFinite(I) ? I.toFixed(0) : '—', 'T (°C)': String(v.T) },
    };
  },
};

// ------------------------------------------------------------------

const bioreactor: Bench = {
  id: 'bench-bioreactor-kla',
  title: 'Bioreactor kLa and validation',
  instrument: 'Stirred-tank bioreactor with Rushton impeller, polarographic DO probe, pH probe, mass-flow controller',
  standards: ['ASME BPE (bioprocessing equipment)'],
  summary: 'Measures kLa by dynamic gassing-out, corrects for probe lag, and checks oxygen transfer against the culture’s demand and impeller shear against the cell line.',
  inputs: [
    { key: 'V', label: 'Working volume', unit: 'L', value: 5, min: 0.5, max: 2000, step: 0.5 },
    { key: 'Di', label: 'Impeller diameter', unit: 'mm', value: 70, min: 20, max: 1000, step: 1 },
    { key: 'rpm', label: 'Agitation', unit: 'rpm', value: 400, min: 30, max: 1500, step: 10 },
    { key: 'vvm', label: 'Air flow', unit: 'vvm', value: 1, min: 0.05, max: 3, step: 0.05 },
    { key: 'Np', label: 'Power number', value: 5, min: 0.3, max: 6, step: 0.1 },
    { key: 'T', label: 'Temperature', unit: '°C', value: 30, min: 20, max: 40, step: 0.5 },
    { key: 'tp', label: 'DO probe response time (63 %)', unit: 's', value: 8, min: 0.5, max: 60, step: 0.5 },
    { key: 'our', label: 'Culture oxygen demand OUR', unit: 'mmol/(L·h)', value: 20, min: 0, max: 300, step: 1 },
    { key: 'cells', label: 'Cell type', value: 0, options: opt(['Microbial (E. coli, yeast)', 'Mammalian (CHO)']) },
    seedInput,
  ],
  run(v) {
    const r = rng(v.seed);
    const V = v.V / 1000, D = v.Di / 1000, N = v.rpm / 60, rho = 1000;
    const Tt = Math.cbrt((4 * V) / Math.PI);
    const P0 = v.Np * rho * N ** 3 * D ** 5;
    const Pg = 0.6 * P0;
    const vs = (v.vvm * V) / 60 / ((Math.PI * Tt * Tt) / 4);
    const kla = 0.026 * (Pg / V) ** 0.4 * vs ** 0.5;
    const Cs = 14.62 - 0.3898 * v.T + 0.006969 * v.T ** 2 - 0.00005897 * v.T ** 3;
    const dt = 0.5, tEnd = Math.min(1800, 6 / kla);
    let C = 0.05 * Cs, Cp = C;
    const tsC: [number, number][] = [], tsP: [number, number][] = [];
    for (let t = 0; t <= tEnd; t += dt) {
      C += dt * kla * (Cs - C);
      Cp += (dt / v.tp) * (C - Cp);
      const read = Cp + 0.004 * Cs * r.gauss();
      tsC.push([t, (100 * C) / Cs]); tsP.push([t, (100 * read) / Cs]);
    }
    const win = tsP.filter(([, y]) => y > 20 && y < 80);
    const p0 = win[0]?.[1] ?? 20;
    const fit = linfit(win.map(([t, y]) => [t, Math.log((100 - y) / (100 - p0))]));
    const klaMeas = -fit.slope;
    const klaCorr = 1 / (1 / klaMeas - v.tp);
    const otr = (klaCorr * 3600 * Cs) / 32;
    const tip = Math.PI * N * D;
    const eps = P0 / (rho * V);
    const nu = 1e-6 * (0.89 - 0.016 * (v.T - 25));
    const eta = (nu ** 3 / eps) ** 0.25 * 1e6;
    const shearOk = v.cells === 1 ? tip <= 1.5 && eta >= 20 : true;
    const o2Ok = otr >= v.our;
    return {
      results: [
        { label: 'kLa measured (raw / probe-corrected)', value: `${(klaMeas * 3600).toFixed(1)} / ${(klaCorr * 3600).toFixed(1)} h⁻¹` },
        { label: 'kLa correlation (van ’t Riet)', value: `${(kla * 3600).toFixed(1)} h⁻¹` },
        { label: 'Saturation DO C*', value: `${Cs.toFixed(2)} mg/L at ${v.T} °C` },
        { label: 'Maximum OTR = kLa·C*', value: `${otr.toFixed(1)} mmol/(L·h) vs demand ${v.our}` },
        { label: 'Gassed power per volume', value: `${(Pg / V).toFixed(0)} W/m³` },
        { label: 'Superficial gas velocity', value: `${(vs * 1000).toFixed(2)} mm/s` },
        { label: 'Impeller tip speed', value: `${tip.toFixed(2)} m/s` },
        { label: 'Kolmogorov eddy length', value: `${eta.toFixed(0)} µm` },
      ],
      charts: [
        { title: 'Dynamic gassing-out', xLabel: 'time (s)', yLabel: 'dissolved oxygen (% sat)', series: [{ label: 'liquid', points: tsC, style: 'dashed', color: '--text-2' }, { label: 'probe reading', points: tsP, color: '--d-fluid' }] },
        { title: 'Log plot for kLa', xLabel: 'time (s)', yLabel: 'ln((100 − DO)/(100 − DO₀))', series: [{ label: '20–80 % window', points: win.map(([t, y]) => [t, Math.log((100 - y) / (100 - p0))]), style: 'points' }, { label: `slope −${(klaMeas * 3600).toFixed(1)} h⁻¹`, points: win.length ? [[win[0][0], fit.slope * win[0][0] + fit.intercept], [win[win.length - 1][0], fit.slope * win[win.length - 1][0] + fit.intercept]] : [], color: '--d-thermal' }] },
      ],
      verdict: { pass: o2Ok && shearOk, text: !o2Ok ? 'Oxygen transfer cannot meet the culture demand: raise agitation or airflow, or enrich with O₂.' : !shearOk ? 'Shear is too high for mammalian cells: tip speed over 1.5 m/s or eddies smaller than about 20 µm.' : 'Oxygen supply meets demand and shear is within the cell line’s tolerance.' },
      notes: ['kLa is fitted between 20 % and 80 % saturation and corrected for the probe’s first-order lag. pH control and CO₂ stripping (kLa for CO₂ ≈ 0.89 × kLa for O₂) and waste metabolites are logged separately during the culture run.'],
      record: { 'kLa (1/h)': (klaCorr * 3600).toFixed(1), 'OTR': otr.toFixed(1), 'tip (m/s)': tip.toFixed(2) },
    };
  },
};

// ------------------------------------------------------------------

const fft: Bench = {
  id: 'bench-fft',
  title: 'Oscilloscope FFT',
  instrument: 'Digital oscilloscope / ADC with FFT math',
  standards: ['IEEE 1241 (ADC test methods)'],
  summary: 'Samples a sine with harmonics, noise and quantization, windows it, and reports THD, SNR, SINAD, ENOB and the noise floor.',
  inputs: [
    { key: 'f', label: 'Signal frequency', unit: 'Hz', value: 1000, min: 1, max: 1e6, step: 1 },
    { key: 'A', label: 'Amplitude', unit: 'V', value: 1, min: 0.001, max: 10, step: 0.001 },
    { key: 'h2', label: '2nd harmonic', unit: '%', value: 1, min: 0, max: 30, step: 0.1 },
    { key: 'h3', label: '3rd harmonic', unit: '%', value: 0.5, min: 0, max: 30, step: 0.1 },
    { key: 'noise', label: 'Noise (RMS)', unit: 'mV', value: 1, min: 0, max: 500, step: 0.1 },
    { key: 'fs', label: 'Sample rate', unit: 'kS/s', value: 48, min: 1, max: 10000, step: 1 },
    { key: 'N', label: 'FFT length', value: 4096, options: [{ value: 1024, label: '1024' }, { value: 4096, label: '4096' }, { value: 16384, label: '16384' }] },
    { key: 'win', label: 'Window', value: 0, options: opt(['Hann', 'Rectangular', 'Flat-top']) },
    { key: 'bits', label: 'ADC resolution', unit: 'bits', value: 12, min: 4, max: 24, step: 1 },
    seedInput,
  ],
  run(v) {
    const r = rng(v.seed);
    const fs = v.fs * 1000, N = v.N;
    const FS = Math.max(1.25 * v.A * (1 + (v.h2 + v.h3) / 100), 0.01);
    const lsb = (2 * FS) / 2 ** v.bits;
    const x = Array.from({ length: N }, (_, i) => {
      const t = i / fs, w = 2 * Math.PI * v.f * t;
      const s = v.A * (Math.sin(w) + (v.h2 / 100) * Math.sin(2 * w + 0.3) + (v.h3 / 100) * Math.sin(3 * w + 0.7)) + (v.noise / 1000) * r.gauss();
      return Math.max(-FS, Math.min(FS, Math.round(s / lsb) * lsb));
    });
    const w = windowFn(v.win, N);
    const cg = w.reduce((a, b) => a + b, 0) / N;
    const enbw = (N * w.reduce((a, b) => a + b * b, 0)) / w.reduce((a, b) => a + b, 0) ** 2;
    const mag = fftMag(x.map((s, i) => s * w[i]));
    const amp = mag.map((m, k) => ((k === 0 ? 1 : 2) * m) / (N * cg));
    const power = amp.map((a) => (a * a) / 2 / enbw);
    const df = fs / N;
    const lobe = v.win === 1 ? 1 : v.win === 0 ? 3 : 6;
    const band = (k0: number) => { let s = 0; for (let k = Math.max(1, k0 - lobe); k <= Math.min(power.length - 1, k0 + lobe); k++) s += power[k]; return s; };
    const k1 = Math.round(v.f / df);
    const used = new Set<number>();
    const mark = (k0: number) => { for (let k = k0 - lobe; k <= k0 + lobe; k++) used.add(k); };
    for (let k = 0; k <= lobe; k++) used.add(k);
    const P1 = band(k1); mark(k1);
    let Ph = 0;
    for (let hN = 2; hN <= 6; hN++) {
      let kh = Math.round((hN * v.f) / df) % N;
      if (kh > N / 2) kh = N - kh;
      if (kh <= lobe || kh >= power.length - 1) continue;
      Ph += band(kh); mark(kh);
    }
    let Pn = 0;
    for (let k = 1; k < power.length; k++) if (!used.has(k)) Pn += power[k];
    const thd = Math.sqrt(Ph / P1);
    const snr = 10 * Math.log10(P1 / Math.max(1e-30, Pn));
    const sinad = 10 * Math.log10(P1 / Math.max(1e-30, Pn + Ph));
    const enob = (sinad - 1.76) / 6.02;
    const db = amp.map((a) => 20 * Math.log10(Math.max(a, 1e-12)));
    const floor = [...db].sort((a, b) => a - b)[Math.floor(db.length / 2)];
    const nPer = Math.max(64, Math.min(N, Math.round((3 * fs) / v.f)));
    return {
      results: [
        { label: 'Frequency resolution Δf', value: `${df.toFixed(2)} Hz (ENBW ${enbw.toFixed(2)} bins)` },
        { label: 'Fundamental', value: `${(Math.sqrt(2 * P1)).toFixed(4)} V peak at ${(k1 * df).toFixed(1)} Hz` },
        { label: 'THD', value: `${(100 * thd).toFixed(3)} % (${(20 * Math.log10(Math.max(thd, 1e-12))).toFixed(1)} dBc)` },
        { label: 'SNR / SINAD', value: `${snr.toFixed(1)} dB / ${sinad.toFixed(1)} dB` },
        { label: 'ENOB', value: `${enob.toFixed(2)} bits (ADC ${v.bits} bits)` },
        { label: 'Median noise floor', value: `${floor.toFixed(1)} dBV per bin` },
      ],
      charts: [
        { title: 'Time record', xLabel: 'time (ms)', yLabel: 'voltage (V)', series: [{ label: 'samples', points: x.slice(0, nPer).map((s, i) => [(i / fs) * 1000, s]), color: '--d-electrical' }] },
        { title: 'Spectrum', xLabel: 'frequency (Hz)', yLabel: 'amplitude (dBV)', series: [{ label: ['Hann', 'rectangular', 'flat-top'][v.win] ?? '', points: db.map((d, k) => [k * df, d] as [number, number]).filter((_, k) => k > 0), color: '--d-electrical' }], marks: [{ y: floor, label: 'noise floor' }] },
      ],
      notes: v.win === 1 && Math.abs(v.f / df - Math.round(v.f / df)) > 0.05 ? ['The signal is not bin-centred, so the rectangular window leaks energy into neighbouring bins and inflates THD and noise. Try Hann.'] : undefined,
      record: { 'THD (%)': (100 * thd).toFixed(3), 'SNR (dB)': snr.toFixed(1), ENOB: enob.toFixed(2) },
    };
  },
};

// ------------------------------------------------------------------

const emc: Bench = {
  id: 'bench-emc',
  title: 'EMC radiated-emission pre-scan',
  instrument: 'Semi-anechoic chamber, biconical/log-periodic antenna at 3 m, EMI receiver (quasi-peak, 120 kHz RBW)',
  standards: ['CISPR 32 / EN 55032', 'CISPR 16-1-4 (test site)'],
  summary: 'Estimates the radiated field of a board’s clock loop from its trapezoidal harmonic spectrum and compares it with the CISPR 32 limit at 3 m.',
  inputs: [
    { key: 'f0', label: 'Clock frequency', unit: 'MHz', value: 25, min: 1, max: 500, step: 0.5 },
    { key: 'V', label: 'Logic swing', unit: 'V', value: 3.3, min: 0.5, max: 12, step: 0.1 },
    { key: 'tr', label: 'Rise time', unit: 'ns', value: 2, min: 0.1, max: 50, step: 0.1 },
    { key: 'duty', label: 'Duty cycle', unit: '%', value: 50, min: 5, max: 95, step: 1 },
    { key: 'area', label: 'Current loop area', unit: 'cm²', value: 4, min: 0.01, max: 100, step: 0.01 },
    { key: 'Z', label: 'Loop impedance', unit: 'Ω', value: 100, min: 10, max: 1000, step: 1 },
    { key: 'ss', label: 'Spread-spectrum clocking', unit: '%', value: 0, min: 0, max: 5, step: 0.1 },
    { key: 'cls', label: 'Limit', value: 0, options: opt(['CISPR 32 Class B (residential)', 'CISPR 32 Class A (industrial)']) },
  ],
  run(v) {
    const f0 = v.f0 * 1e6, T = 1 / f0, d = v.duty / 100, tr = v.tr * 1e-9, A = v.area * 1e-4, R = 3;
    const sinc = (x: number) => (Math.abs(x) < 1e-12 ? 1 : Math.sin(x) / x);
    const limit = (f: number) => (f < 230e6 ? 40 : 47) + (v.cls === 1 ? 10.5 : 0);
    const em: [number, number][] = [];
    let worst = { margin: Infinity, f: 0 }, over = 0;
    for (let nH = 1; nH * f0 <= 1e9; nH++) {
      const f = nH * f0;
      if (f < 30e6) continue;
      const cn = 2 * v.V * d * Math.abs(sinc(nH * Math.PI * d)) * Math.abs(sinc((nH * Math.PI * tr) / T));
      const I = cn / v.Z;
      const E = (263e-16 * f * f * A * I) / R;
      let dbuv = 20 * Math.log10(Math.max(E, 1e-15) * 1e6);
      if (v.ss > 0) dbuv -= Math.max(0, 10 * Math.log10(((v.ss / 100) * f) / 120e3));
      if (dbuv < -20) continue;
      em.push([f / 1e6, dbuv]);
      const mg = limit(f) - dbuv;
      if (mg < worst.margin) worst = { margin: mg, f };
      if (mg < 0) over++;
    }
    const lim: [number, number][] = [[30, limit(30e6)], [230, limit(30e6)], [230, limit(300e6)], [1000, limit(300e6)]];
    const pass = worst.margin >= 3;
    return {
      results: [
        { label: 'Harmonics in 30 MHz – 1 GHz', value: String(em.length) },
        { label: 'Worst margin to limit', value: Number.isFinite(worst.margin) ? `${worst.margin.toFixed(1)} dB at ${(worst.f / 1e6).toFixed(0)} MHz` : '—' },
        { label: 'Harmonics over the limit', value: String(over) },
        { label: 'Spectrum corners 1/(πτ), 1/(πtr)', value: `${(1 / (Math.PI * d * T) / 1e6).toFixed(0)} MHz, ${(1 / (Math.PI * tr) / 1e6).toFixed(0)} MHz` },
      ],
      charts: [{ title: 'Radiated emissions at 3 m (differential-mode estimate)', xLabel: 'frequency (MHz)', yLabel: 'field (dBµV/m)', xLog: true, xRange: [30, 1000], series: [{ label: 'clock harmonics', points: em, style: 'bars', color: '--d-electrical' }, { label: v.cls === 1 ? 'Class A limit' : 'Class B limit', points: lim, color: '--crit' }] }],
      verdict: { pass, text: pass ? `Pre-scan passes with ${worst.margin.toFixed(1)} dB margin. Confirm with a full quasi-peak scan in the chamber.` : `Pre-scan margin ${worst.margin.toFixed(1)} dB is under 3 dB: slow the edges, shrink the loop, or enable spread-spectrum.` },
      notes: ['E = 263×10⁻¹⁶·f²·A·I / r (Ott, with ground reflection). Common-mode cable current usually dominates real emissions, so treat this as a lower bound.'],
      record: { 'f0 (MHz)': String(v.f0), 'margin (dB)': Number.isFinite(worst.margin) ? worst.margin.toFixed(1) : '—', over: String(over) },
    };
  },
};

export const BENCHES: Bench[] = [
  tensile, charpy, fatigue, hardness, torsion, springTest, morse, pipeFriction, venturi, reynolds, heatExchanger,
  hotfire, windTunnel, concrete, shakeTable, bomb, gc, bioreactor, fft, emc,
];

export const BENCH_BY_ID = new Map(BENCHES.map((b) => [b.id as string, b]));

export function defaults(b: Bench): Record<string, number> {
  return Object.fromEntries(b.inputs.map((i) => [i.key, i.value]));
}
