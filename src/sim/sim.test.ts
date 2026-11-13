import { describe, expect, it } from 'vitest';
import { Simulator } from './core';
import {
  ambient, battery, capacitor, damper, dcMotor, flywheel, gearbox, heatMass, ModelBuilder, resistor, thermalResistance,
} from './components';
import { SCENES } from './scenes';

function simFor(b: ModelBuilder, h: number, method: 'be' | 'trap' = 'be', initial?: (id: string) => number | undefined) {
  return new Simulator(b.nodes, b.elements(), { h, method, initial });
}

function runFor(sim: Simulator, seconds: number) {
  const steps = Math.round(seconds / sim.h);
  for (let i = 0; i < steps; i++) expect(sim.step()).toBe(true);
}

describe('electrical', () => {
  it('charges an RC network along 1 − e^(−t/τ)', () => {
    const b = new ModelBuilder();
    battery(b, 'B1', 'Battery', 'p', 'gnd', 5, 1e-6);
    resistor(b, 'R1', 'R', 'p', 'c', 1e3);
    const C1 = capacitor(b, 'C1', 'C', 'c', 'gnd', 100e-6);
    const sim = simFor(b, 1e-4, 'trap');
    runFor(sim, 0.1); // one time constant
    const expected = 5 * (1 - Math.exp(-1));
    expect(Math.abs(C1.voltage(sim) - expected) / expected).toBeLessThan(2e-3);
  });

  it('blinks the 555 at 1.44 / ((R1 + 2·R2)·C1)', () => {
    const def = SCENES.find((s) => s.id === 'led-blinker')!;
    const scene = def.create();
    const sim = new Simulator(scene.nodes, scene.elements, { h: def.h, method: def.method, initial: scene.initial });
    runFor(sim, 4);
    const U1 = scene.components.find((c) => c.id === 'U1') as unknown as { state: { period: number } };
    const predicted = 1.44 / ((1e3 + 2 * 10e3) * 47e-6);
    expect(U1.state.period).toBeGreaterThan(0);
    expect(Math.abs(1 / U1.state.period - predicted) / predicted).toBeLessThan(0.03);
    const led = scene.components.find((c) => c.id === 'D1') as unknown as { current(): number };
    expect(led.current()).toBeGreaterThanOrEqual(0);
  });
});

describe('electromechanical', () => {
  it('reaches the analytic steady state of a DC motor driving a geared flywheel', () => {
    const b = new ModelBuilder();
    battery(b, 'B1', 'Battery', 'p', 'gnd', 6, 0.2);
    const M1 = dcMotor(b, 'M1', 'Motor', { p: 'p', n: 'gnd', shaft: 'wm', heat: 'th.w' });
    M1.params.find((p) => p.key === 'alpha')!.value = 0; // isolate the electromechanics
    gearbox(b, 'G1', 'Gearbox', 'wm', 'wf', 3);
    const F1 = flywheel(b, 'F1', 'Flywheel', 'wf', 2.4e-4);
    damper(b, 'D1', 'Drag', 'wf', 4e-4);
    // A heat path so the thermal node is well defined.
    heatMass(b, 'W1', 'Mass', 'th.w', 4.2);
    thermalResistance(b, 'R1', 'Rth', 'th.w', 'th.a', 18);
    ambient(b, 'A1', 'Air', 'th.a', 22);
    const sim = simFor(b, 5e-4, 'be', (id) => (id.startsWith('th.') ? 295.15 : undefined));
    runFor(sim, 4);
    const k = 0.012, R = 2.4 + 0.2, bEff = 1e-6 + 4e-4 / 9;
    const wm = 6 / (k + (R * bEff) / k);
    expect(Math.abs(F1.omega(sim) - wm / 3) / (wm / 3)).toBeLessThan(1e-3);
    expect(Math.abs(M1.current() - (bEff * wm) / k) / ((bEff * wm) / k)).toBeLessThan(1e-3);
  });
});

describe('energy ledger', () => {
  it('balances the motor scene to better than 0.01 % with implicit Euler', () => {
    const def = SCENES.find((s) => s.id === 'motor-flywheel')!;
    const scene = def.create();
    const sim = new Simulator(scene.nodes, scene.elements, { h: def.h, method: 'be', initial: scene.initial });
    runFor(sim, 8);
    const L = sim.ledger();
    expect(L.supplied).toBeGreaterThan(40);
    expect(Math.abs(L.relResidual)).toBeLessThan(1e-4);
  });

  it('flags implicit Euler damping on an oscillator and clears with trapezoidal', () => {
    const def = SCENES.find((s) => s.id === 'torsion-pendulum')!;
    const run = (method: 'be' | 'trap') => {
      const scene = def.create();
      const sim = new Simulator(scene.nodes, scene.elements, { h: def.h, method, initial: scene.initial });
      runFor(sim, 5);
      return sim.ledger();
    };
    const be = run('be');
    const trap = run('trap');
    expect(be.relResidual).toBeGreaterThan(0.01);
    expect(Math.abs(trap.relResidual)).toBeLessThan(1e-5);
  });

  it('keeps every scene converging for 2 s', () => {
    for (const def of SCENES) {
      const scene = def.create();
      const sim = new Simulator(scene.nodes, scene.elements, { h: def.h, method: def.method, initial: scene.initial });
      runFor(sim, 2);
      expect(sim.status).toBe('ok');
    }
  });
});
