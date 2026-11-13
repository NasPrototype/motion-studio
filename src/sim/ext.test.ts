import { describe, expect, it } from 'vitest';
import { Simulator } from './core';
import { SCENES } from './scenes';
import { LIBRARY } from './library';
import { compileProject, type Project } from './project';
import type { Component } from './components';

function start(id: string, tweak?: (c: Component[]) => void) {
  const def = SCENES.find((d) => d.id === id)!;
  const inst = def.create();
  tweak?.(inst.components);
  const sim = new Simulator(inst.nodes, inst.elements, { h: def.h, method: def.method, initial: inst.initial });
  const get = <T = Component>(cid: string) => inst.components.find((c) => c.id === cid) as unknown as T;
  const runTo = (T: number, each?: () => void) => { while (sim.t < T) { expect(sim.step(), sim.failure).toBe(true); each?.(); } };
  return { sim, inst, get, runTo };
}

describe('mechanical scenes', () => {
  it('spring–mass–damper rings at √(k/m)/2π and decays at ζ = c/(2√(km))', () => {
    const { sim, get, runTo } = start('spring-mass-damper');
    const K = get<{ deflection(): number }>('K1');
    const crossings: number[] = [];
    let prev = K.deflection();
    runTo(2, () => { const x = K.deflection(); if (prev > 0 && x <= 0) crossings.push(sim.t); prev = x; });
    const period = (crossings[crossings.length - 1] - crossings[0]) / (crossings.length - 1);
    expect(1 / period).toBeCloseTo(Math.sqrt(400 / 1) / (2 * Math.PI) * Math.sqrt(1 - 0.05 ** 2), 1);
    expect(Math.abs(sim.ledger().relResidual)).toBeLessThan(1e-3);
  });

  it('quarter car settles after the bump and conserves energy', () => {
    const { sim, get, runTo } = start('quarter-car');
    const MS = get<{ acceleration(): number }>('MS');
    let peak = 0;
    runTo(4, () => { peak = Math.max(peak, Math.abs(MS.acceleration())); });
    expect(peak).toBeGreaterThan(0.2);
    expect(peak).toBeLessThan(25);
    expect(Math.abs(MS.acceleration())).toBeLessThan(0.05);
    expect(Math.abs(sim.ledger().relResidual)).toBeLessThan(1e-3);
  });
});

describe('robotics scenes', () => {
  it('PID joint reaches its 60° target against gravity', () => {
    const { sim, get, runTo } = start('robot-joint');
    runTo(3);
    const L = get<{ angle(): number }>('L1');
    expect((L.angle() * 180) / Math.PI).toBeCloseTo(60, 0);
    expect(Math.abs(sim.ledger().relResidual)).toBeLessThan(1e-3);
  });

  it('3-axis arm reaches the pick pose and returns home', () => {
    const { get, runTo } = start('robot-arm');
    const deg = (id: string) => (get<{ angle(): number }>(id).angle() * 180) / Math.PI;
    runTo(2.2);
    expect(deg('L1')).toBeCloseTo(32.9, 0);
    expect(Math.abs(deg('L3') + 58.2)).toBeLessThan(1.5);
    runTo(7.5);
    expect(Math.abs(deg('L2') - 50)).toBeLessThan(1);
  });
});

describe('rocket engine', () => {
  type Chamber = { state: { pc: number; thrust: number; mr: number; isp: number; burning: boolean } };
  it('fires at about 2 kN, 15 bar and O/F near 1.3, then shuts down', () => {
    const { sim, get, runTo } = start('rocket-engine');
    const E = get<Chamber>('E1');
    runTo(2.0);
    expect(E.state.burning).toBe(true);
    expect(E.state.pc / 1e5).toBeGreaterThan(13);
    expect(E.state.pc / 1e5).toBeLessThan(18);
    expect(E.state.thrust).toBeGreaterThan(1700);
    expect(E.state.thrust).toBeLessThan(2400);
    expect(E.state.mr).toBeGreaterThan(1.0);
    expect(E.state.mr).toBeLessThan(1.6);
    expect(E.state.isp).toBeGreaterThan(190);
    expect(E.state.isp).toBeLessThan(260);
    const lc = get<{ force(): number }>('LC');
    expect(lc.force()).toBeCloseTo(E.state.thrust, -1);
    runTo(4.2);
    expect(E.state.burning).toBe(false);
    expect(E.state.thrust).toBe(0);
    expect(Math.abs(sim.ledger().relResidual)).toBeLessThan(1e-3);
  });

  it('chugs when the combustion time lag is long', () => {
    const peakToPeak = (tau: number) => {
      const { get, runTo } = start('rocket-engine', (cs) => { cs.find((c) => c.id === 'E1')!.params.find((p) => p.key === 'tau')!.value = tau; });
      const E = get<Chamber>('E1');
      let lo = Infinity, hi = -Infinity;
      runTo(2.0);
      runTo(2.6, () => { lo = Math.min(lo, E.state.pc); hi = Math.max(hi, E.state.pc); });
      return (hi - lo) / 1e5;
    };
    expect(peakToPeak(0.002)).toBeLessThan(0.05);
    expect(peakToPeak(0.006)).toBeGreaterThan(5);
  });
});

describe('fluid power', () => {
  it('pump lifts the load, then dead-heads when the valve closes', () => {
    const { get, runTo, sim } = start('pump-loop');
    const L = get<{ position(): number }>('L1');
    runTo(3.0);
    const lifted = L.position();
    expect(lifted).toBeGreaterThan(0.05);
    runTo(4.0);
    expect(L.position() - lifted).toBeLessThan(0.02);
    const P = get<Component>('P1');
    expect((sim.effort(P.ports[2].node) - 101325) / 1e5).toBeGreaterThan(15);
  });
});

describe('library', () => {
  it('has at least 36 part types with unique type names', () => {
    expect(LIBRARY.length).toBeGreaterThanOrEqual(36);
    expect(new Set(LIBRARY.map((t) => t.type)).size).toBe(LIBRARY.length);
  });

  it('every part builds alone in a project and steps without failing', () => {
    for (const t of LIBRARY) {
      const p: Project = { version: 1, id: 't', name: 't', parts: [{ id: `${t.prefix}1`, type: t.type, pos: [0, 0], rot: 0, params: {} }], wires: [] };
      const { scene } = compileProject(p);
      const sim = new Simulator(scene.nodes, scene.elements, { h: 5e-4, method: 'be', initial: scene.initial });
      for (let i = 0; i < 40; i++) expect(sim.step(), `${t.type}: ${sim.failure}`).toBe(true);
    }
  });

  it('wires a tank, valve, pipe and orifice into a working fluid circuit', () => {
    const p: Project = {
      version: 1, id: 'f', name: 'f',
      parts: [
        { id: 'T1', type: 'tank', pos: [-8, 0], rot: 0, params: { p: 5e5 } },
        { id: 'V1', type: 'valve', pos: [-3, 0], rot: 0, params: { open: 0 } },
        { id: 'PL1', type: 'pipe', pos: [2, 0], rot: 0, params: {} },
        { id: 'OR1', type: 'orifice', pos: [7, 0], rot: 0, params: {} },
        { id: 'TR1', type: 'reservoir', pos: [11, 0], rot: 0, params: {} },
      ],
      wires: [
        { id: 'w1', a: { part: 'T1', port: 'out' }, b: { part: 'V1', port: 'in' } },
        { id: 'w2', a: { part: 'V1', port: 'out' }, b: { part: 'PL1', port: 'in' } },
        { id: 'w3', a: { part: 'PL1', port: 'out' }, b: { part: 'OR1', port: 'in' } },
        { id: 'w4', a: { part: 'OR1', port: 'out' }, b: { part: 'TR1', port: 'port' } },
      ],
    };
    const { scene } = compileProject(p);
    const sim = new Simulator(scene.nodes, scene.elements, { h: 5e-4, method: 'be', initial: scene.initial });
    while (sim.t < 1) expect(sim.step(), sim.failure).toBe(true);
    const orifice = scene.components.find((c) => c.id === 'OR1')!;
    const flow = orifice.elements[0].flows[0];
    // Orifice limits the flow: ṁ ≈ Cd·A·√(2ρΔp) with almost all of the 4 bar across it.
    expect(flow).toBeGreaterThan(0.8 * 10e-6 * Math.sqrt(2 * 1000 * 4e5));
    expect(flow).toBeLessThan(1.05 * 10e-6 * Math.sqrt(2 * 1000 * 4e5));
  });
});
