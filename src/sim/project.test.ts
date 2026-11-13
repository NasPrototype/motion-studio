import { describe, expect, it } from 'vitest';
import { Simulator } from './core';
import { compileProject, nextId, type Project, STARTER, wireError } from './project';

function run(p: Project, seconds: number) {
  const { scene, problems } = compileProject(p);
  const sim = new Simulator(scene.nodes, scene.elements, { h: 5e-4, method: 'be', initial: scene.initial });
  for (let i = 0; i < seconds / sim.h; i++) if (!sim.step()) throw new Error(sim.failure);
  return { sim, scene, problems };
}

describe('project compiler', () => {
  it('runs the starter LED circuit at the expected current', () => {
    const { scene } = run(STARTER, 0.2);
    const led = scene.components.find((c) => c.id === 'D1')!;
    const i = led.elements[0].flows[0];
    // (9 V − ~1.9 V) / (330 Ω + LED series + battery) ≈ 21 mA
    expect(i).toBeGreaterThan(0.018);
    expect(i).toBeLessThan(0.023);
  });

  it('refuses wires across domains and duplicates', () => {
    const p: Project = { ...STARTER, parts: [...STARTER.parts, { id: 'M1', type: 'dcmotor', pos: [0, 10], rot: 0, params: {} }] };
    expect(wireError(p, { part: 'B1', port: 'p' }, { part: 'M1', port: 'shaft' })).toMatch(/electrical port to a rotational/);
    expect(wireError(p, { part: 'B1', port: 'p' }, { part: 'S1', port: 'a' })).toMatch(/already connected/);
    expect(wireError(p, { part: 'B1', port: 'p' }, { part: 'M1', port: 'p' })).toBeNull();
    expect(nextId(p, 'M')).toBe('M2');
  });

  it('cools an unconnected motor heat port to still air and stays solvable with a free gearbox', () => {
    const p: Project = {
      version: 1, id: 't', name: 't',
      parts: [
        { id: 'B1', type: 'battery', pos: [0, 0], rot: 0, params: { E: 6 } },
        { id: 'M1', type: 'dcmotor', pos: [8, 0], rot: 0, params: {} },
        { id: 'G1', type: 'gearbox', pos: [16, 0], rot: 0, params: {} },
        { id: 'GND1', type: 'ground', pos: [0, 6], rot: 0, params: {} },
      ],
      wires: [
        { id: 'w1', a: { part: 'B1', port: 'p' }, b: { part: 'M1', port: 'p' } },
        { id: 'w2', a: { part: 'M1', port: 'n' }, b: { part: 'GND1', port: 'g' } },
        { id: 'w3', a: { part: 'B1', port: 'n' }, b: { part: 'GND1', port: 'g' } },
      ],
    };
    const { sim, problems } = run(p, 1);
    expect(problems.some((x) => /still air/.test(x.text) || /cools to 22/.test(x.text))).toBe(true);
    expect(sim.status).toBe('ok');
    // An unloaded motor spins up in ~20 ms, so implicit Euler's startup error is a visible share of the little energy used.
    expect(Math.abs(sim.ledger().relResidual)).toBeLessThan(1e-2);
  });

  it('warns when a circuit has no ground', () => {
    const p: Project = { ...STARTER, parts: STARTER.parts.filter((x) => x.type !== 'ground'), wires: STARTER.wires.filter((w) => w.b.part !== 'GND1') };
    expect(compileProject(p).problems.some((x) => /No Ground/.test(x.text))).toBe(true);
  });
});
