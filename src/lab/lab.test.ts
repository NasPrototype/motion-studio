import { describe, expect, it } from 'vitest';
import { ENTRIES, BRANCH_COUNTS, LAB_COUNTS } from './index';
import { BRANCHES, FACILITIES } from './facilities';
import { SIM_TARGETS } from './types';
import { BENCHES, BENCH_BY_ID, defaults } from './benches';
import { SCENES } from '../sim/scenes';

describe('reference library', () => {
  it('has unique ids and valid simulation links', () => {
    expect(new Set(ENTRIES.map((e) => e.id)).size).toBe(ENTRIES.length);
    for (const e of ENTRIES) if (e.sim) expect(Object.keys(SIM_TARGETS), e.id).toContain(e.sim);
  });

  it('covers every one of the 27 branches with at least 10 entries', () => {
    expect(BRANCHES.length).toBe(27);
    for (const b of BRANCHES) expect(BRANCH_COUNTS.get(b.id)?.total ?? 0, b.id).toBeGreaterThanOrEqual(10);
  });

  it('tags at least 10 entries to each of the 16 teaching labs', () => {
    expect(FACILITIES.length).toBe(16);
    for (const f of FACILITIES) expect(LAB_COUNTS.get(f.id)?.total ?? 0, f.id).toBeGreaterThanOrEqual(10);
  });

  it('includes the blueprints and tests asked for by name', () => {
    const titles = ENTRIES.map((e) => e.title.toLowerCase()).join('\n');
    for (const k of ['monocoque', 'morse', 'charpy', 'tensile', 'fatigue', 'friction factor', 'rocket', 'hot-fire', 'wind tunnel', 'steel building', 'cylinder', 'shake-table', 'p&id', 'microfluidic', 'gc', 'bomb calorimet', 'bioreactor', 'embedded control', 'fft', 'emc']) {
      expect(titles, k).toContain(k);
    }
  });

  it('points every simulation target at a real scene or bench', () => {
    for (const id of Object.keys(SIM_TARGETS)) expect(SCENES.some((s) => s.id === id) || BENCH_BY_ID.has(id), id).toBe(true);
  });
});

describe('virtual benches', () => {
  it('every bench runs with its defaults and gives finite headline numbers', () => {
    for (const b of BENCHES) {
      const out = b.run(defaults(b));
      expect(out.results.length, b.id).toBeGreaterThan(2);
      expect(out.charts.length, b.id).toBeGreaterThan(0);
      for (const c of out.charts) for (const s of c.series) expect(s.points.length, `${b.id}: ${c.title}`).toBeGreaterThan(0);
      expect(Object.keys(out.record).length, b.id).toBeGreaterThan(0);
    }
  });

  const num = (s: string) => parseFloat(s.replace(/[^0-9.eE+-]+/g, ' ').trim().split(' ')[0]);
  const result = (id: string, label: string, over: Record<string, number> = {}) => {
    const b = BENCH_BY_ID.get(id)!;
    const out = b.run({ ...defaults(b), ...over });
    const r = out.results.find((x) => x.label.startsWith(label));
    if (!r) throw new Error(`${id}: no result "${label}"`);
    return { value: num(r.value), out };
  };

  it('tensile 0.2 % offset yield and modulus land on the material data', () => {
    expect(result('bench-tensile', 'Yield strength', { mat: 1 }).value).toBeGreaterThan(260);
    expect(result('bench-tensile', 'Yield strength', { mat: 1 }).value).toBeLessThan(295);
    expect(result('bench-tensile', "Young's modulus", { mat: 0 }).value).toBeCloseTo(205, -1);
  });

  it('Morse test recovers the friction power within a few percent', () => {
    const fp = result('bench-morse', 'Friction power').value;
    expect(fp).toBeGreaterThan(4.6);
    expect(fp).toBeLessThan(5.4);
  });

  it('pipe friction matches Colebrook and the shake table matches the shear-frame modes', () => {
    const { out } = result('bench-pipe-friction', 'Measured friction factor');
    const meas = num(out.results.find((r) => r.label.startsWith('Measured'))!.value);
    const cole = num(out.results.find((r) => r.label.startsWith('Colebrook'))!.value);
    expect(Math.abs(meas - cole) / cole).toBeLessThan(0.05);
    // f1 = 0.445·√(k/m)/2π for three equal floors.
    expect(result('bench-shake-table', 'Natural frequencies').value).toBeCloseTo((0.445 * Math.sqrt(30000 / 5)) / (2 * Math.PI), 1);
  });

  it('FFT THD matches the injected harmonics and Kovats identifies the unknown', () => {
    expect(result('bench-fft', 'THD').value).toBeCloseTo(Math.hypot(1, 0.5), 1);
    expect(Math.abs(result('bench-gc-retention', 'Kovats index').value - 855)).toBeLessThan(10);
  });

  it('bomb calorimeter recovers the coal heating value and concrete acceptance follows ACI', () => {
    expect(Math.abs(result('bench-bomb-calorimeter', 'Gross calorific value').value - 30.2)).toBeLessThan(0.5);
    expect(result('bench-concrete', 'Mean strength').out.verdict?.pass).toBe(true);
    expect(result('bench-concrete', 'Mean strength', { over: -4 }).out.verdict?.pass).toBe(false);
  });

  it('hot-fire bench reports a stable 2 kN run and flags a chug', () => {
    expect(result('bench-hotfire', 'Steady thrust').value).toBeGreaterThan(1700);
    expect(result('bench-hotfire', 'Steady thrust').out.verdict?.pass).toBe(true);
    expect(result('bench-hotfire', 'Steady thrust', { tau: 6 }).out.verdict?.pass).toBe(false);
  });
});
