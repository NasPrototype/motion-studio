import { describe, expect, it } from 'vitest';
import { Simulator } from '../sim/core';
import { compileProject } from '../sim/project';
import { encodeCommand, parseLine } from '../hw/protocol';
import { channelsFor, defaultBindings, rcSetProperty, twinFrame } from './unreal';
import { draftToProject } from '../photo/toProject';
import { normalizeDraft } from '../photo/types';
import { SAMPLE_DRAFT } from '../photo/sample';

describe('photo to twin', () => {
  it('turns the sample draft into a 555 blinker that runs at the predicted rate', () => {
    const { project, notes } = draftToProject(SAMPLE_DRAFT, { q1: 10000, q2: 47e-6, q3: 1 }, 'sample');
    expect(notes).toEqual([]);
    expect(project.wires.length).toBe(SAMPLE_DRAFT.connections.length);
    const { scene, problems } = compileProject(project);
    expect(problems.filter((p) => p.level === 'warn')).toEqual([]);
    const sim = new Simulator(scene.nodes, scene.elements, { h: 5e-4, method: 'be', initial: scene.initial });
    for (let i = 0; i < 4 / sim.h; i++) expect(sim.step()).toBe(true);
    const U1 = scene.components.find((c) => c.id === 'U1') as unknown as { state: { period: number } };
    const predicted = 1.44 / ((1000 + 2 * 10000) * 47e-6);
    expect(Math.abs(1 / U1.state.period - predicted) / predicted).toBeLessThan(0.03);
  });

  it('records an assumption for each unanswered question and keeps parts apart', () => {
    const { project, notes } = draftToProject(SAMPLE_DRAFT, {}, 'sample');
    expect(notes.filter((n) => n.startsWith('Assumed')).length).toBe(3);
    for (const a of project.parts) for (const b of project.parts) {
      if (a !== b) expect(Math.hypot(a.pos[0] - b.pos[0], a.pos[1] - b.pos[1])).toBeGreaterThan(2);
    }
  });

  it('drops unknown part types and clamps boxes from untrusted drafts', () => {
    const d = normalizeDraft({
      summary: 'x',
      parts: [{ ref: 'X1', type: 'warp-drive', box: {} }, { ref: 'R1', type: 'resistor', confidence: 7, box: { x: 0.9, y: -1, w: 5, h: 0.2 }, params: [{ key: 'R', value: '220' }] }],
      connections: [{ a: { ref: 'R1', port: 'a' }, b: { ref: 'X1', port: 'b' } }],
    });
    expect(d.parts.map((p) => p.ref)).toEqual(['R1']);
    expect(d.parts[0].confidence).toBe(1);
    expect(d.parts[0].box.x + d.parts[0].box.w).toBeLessThanOrEqual(1);
    expect(d.parts[0].params).toEqual([{ key: 'R', value: 220 }]);
    expect(d.connections).toEqual([]);
  });
});

describe('EMS Link protocol', () => {
  it('parses hello, telemetry, acks and plain key:value lines', () => {
    const h = parseLine('{"hello":{"device":"rig","watchdog_ms":500,"channels":["rpm",{"key":"temp","unit":"°C"}],"commands":[{"key":"pwm","min":0,"max":255,"rate":100,"safe":0}]}}');
    expect(h.kind).toBe('hello');
    if (h.kind === 'hello') {
      expect(h.hello.channels.map((c) => c.key)).toEqual(['rpm', 'temp']);
      expect(h.hello.commands[0]).toMatchObject({ key: 'pwm', min: 0, max: 255, rate: 100, safe: 0 });
      expect(h.hello.watchdogMs).toBe(500);
    }
    expect(parseLine('{"v":{"rpm":871.5,"bad":"x"}}')).toEqual({ kind: 'telemetry', values: { rpm: 871.5 } });
    expect(parseLine('vc:4.213,rpm:871')).toEqual({ kind: 'telemetry', values: { vc: 4.213, rpm: 871 } });
    expect(parseLine('{"ack":7,"ok":false,"reason":"range"}')).toEqual({ kind: 'ack', seq: 7, ok: false, reason: 'range' });
    expect(parseLine('booting...').kind).toBe('unknown');
  });

  it('rejects commands with an empty range and encodes one JSON line per message', () => {
    const h = parseLine('{"hello":{"device":"x","commands":[{"key":"bad","min":5,"max":5}]}}');
    expect(h.kind === 'hello' && h.hello.commands.length).toBe(0);
    const line = encodeCommand(3, { pwm: 24 }, 600);
    expect(line.endsWith('\n')).toBe(true);
    expect(JSON.parse(line)).toEqual({ cmd: { pwm: 24 }, seq: 3, ttl: 600 });
  });
});

describe('Unreal connector', () => {
  it('builds Remote Control property writes keyed by property name', () => {
    const m = rcSetProperty('/Game/Maps/Studio.Studio:PersistentLevel', 'M1', 'EMS_shaft_angle', 42.5, 9);
    expect(m.MessageName).toBe('http');
    expect(m.Parameters).toMatchObject({ RequestId: 9, Url: '/remote/object/property', Verb: 'PUT' });
    expect(m.Parameters.Body).toEqual({
      objectPath: '/Game/Maps/Studio.Studio:PersistentLevel.M1', access: 'WRITE_ACCESS',
      propertyName: 'EMS_shaft_angle', propertyValue: { EMS_shaft_angle: 42.5 },
    });
    expect(twinFrame(1.5, { M1: { EMS_shaft_angle: 3 } })).toEqual({ type: 'ems.frame', version: 1, t: 1.5, parts: { M1: { EMS_shaft_angle: 3 } } });
  });

  it('offers rotation, temperature and brightness channels and enables the motion ones by default', () => {
    const { project } = draftToProject(SAMPLE_DRAFT, { q1: 10000, q2: 47e-6, q3: 1 }, 's');
    project.parts.push({ id: 'M1', type: 'dcmotor', pos: [30, 30], rot: 0, params: {} });
    const { scene } = compileProject(project);
    const motor = scene.components.find((c) => c.id === 'M1')!;
    const keys = channelsFor(motor).map((c) => c.key);
    expect(keys).toEqual(expect.arrayContaining(['shaft.angle', 'shaft.rpm', 'heat.tempC', 'p.volts']));
    const bindings = defaultBindings(scene.components);
    expect(bindings.find((b) => b.component === 'M1' && b.channel === 'shaft.angle')?.enabled).toBe(true);
    expect(bindings.find((b) => b.component === 'D1' && b.channel === 'brightness')?.enabled).toBe(true);
    expect(bindings.find((b) => b.component === 'M1' && b.channel === 'p.volts')?.enabled).toBe(false);
  });
});
