import { type Element, GROUND, type Simulator } from './core';
import { Conductance } from './elements';
import { FlowSource } from './elements-ext';
import {
  ambient, battery, type Component, dcMotor, gearbox, heatMass, ModelBuilder, param, switchPart, thermalResistance,
} from './components';
import {
  atmosphere, feedLine, fluidVolume, forceSource, hydraulicCylinder, linearDamper, linearSpring, mass, orifice, pdPump,
  pressureTank, roadProfile, robotLink, servoDrive, thrustChamber, valve,
} from './components-ext';
import type { SceneDef, Vec3 } from './scenes';
import { si, toCelsius, toRpm } from './units';

/*
 * Mechanical, robotics, fluid-power and propulsion examples. Scenes here only use type imports
 * from scenes.ts, so the two files can list each other without a load-order cycle.
 */

const ATM = 101325;
const DEG = Math.PI / 180;

function arc(a: Vec3, b: Vec3, lift: number, n = 8): Vec3[] {
  const pts: Vec3[] = [];
  for (let i = 0; i <= n; i++) {
    const s = i / n;
    pts.push([a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s + Math.sin(Math.PI * s) * lift, a[2] + (b[2] - a[2]) * s]);
  }
  return pts;
}

/** Room temperature for thermal nodes and one atmosphere for fluid nodes. */
function initialFor(b: ModelBuilder) {
  const dom = new Map(b.nodes.map((n) => [n.id, n.domain]));
  return (id: string) => {
    const d = dom.get(id);
    return d === 'thermal' ? 295.15 : d === 'fluid' ? ATM : undefined;
  };
}

function setParams(c: Component, values: Record<string, number>): void {
  for (const [k, v] of Object.entries(values)) {
    const p = c.params.find((x) => x.key === k);
    if (p) p.value = v;
  }
}

const smoothstep = (s: number) => (s <= 0 ? 0 : s >= 1 ? 1 : 0.5 - 0.5 * Math.cos(Math.PI * s));

/** Joint-space trajectory through timed waypoints with cosine blending between them. */
function trajectory(points: { t: number; q: number[] }[]) {
  return (t: number): number[] => {
    if (t <= points[0].t) return points[0].q;
    for (let i = 1; i < points.length; i++) {
      if (t <= points[i].t) {
        const a = points[i - 1], b = points[i];
        const s = smoothstep((t - a.t) / (b.t - a.t));
        return a.q.map((v, j) => v + (b.q[j] - v) * s);
      }
    }
    return points[points.length - 1].q;
  };
}

// ------------------------------------------------------------------------------------------

const springMassDamper: SceneDef = {
  id: 'spring-mass-damper',
  name: 'Spring–mass–damper',
  summary: 'A 1 kg block on a 400 N/m spring and a 2 N·s/m damper, released from 20 mm. Free vibration at 3.18 Hz with a 5 % damping ratio.',
  tip: 'Set the damping c to 40 N·s/m for critical damping (c = 2√(k·m)), or give the external force F1 a value to shift the rest position by F/k.',
  h: 5e-4,
  method: 'trap',
  defaultSelection: 'M1',
  create() {
    const b = new ModelBuilder();
    const M1 = mass(b, 'M1', 'Block', 'v.m', 1);
    const K1 = linearSpring(b, 'K1', 'Spring', 'v.m', 'gnd', 400, 8);
    const C1 = linearDamper(b, 'C1', 'Damper', 'v.m', 'gnd', 2);
    forceSource(b, 'F1', 'External force', 'v.m', 0);
    const x = () => K1.deflection();
    const stored = (s: Simulator) => M1.elements[0].stored((n) => s.effort(n)) + K1.elements[0].stored(() => 0);
    return {
      nodes: b.nodes, elements: b.elements(), components: b.components, initial: initialFor(b),
      traces: [
        { label: 'Displacement', unit: 'mm', domain: 'translational', get: () => x() * 1000 },
        { label: 'Velocity', unit: 'm/s', domain: 'translational', get: (s) => M1.velocity(s) },
        { label: 'Stored energy', unit: 'J', domain: 'translational', get: stored, min: 0 },
      ],
      camera: { pos: [10, 9, 17], target: [0, 2, 0] },
      items: [{ kind: 'smdRig', component: 'M1', pos: [0, 0, 0], opts: { mass: 'M1', spring: 'K1', damper: 'C1', gain: 40 }, drive: () => ({ x: x() }) }],
      wires: [],
      labels: [
        { component: 'M1', anchor: [1.5, 4.4, 0], lines: (s) => [{ text: si(x() * 1000, 'mm'), domain: 'translational' }, { text: si(M1.velocity(s), 'm/s'), domain: 'translational' }] },
        { component: 'K1', anchor: [-3.2, 4.0, 0.7], lines: () => [{ text: si(K1.force(), 'N'), domain: 'translational' }] },
        { component: 'C1', anchor: [-3.2, 0.6, -2.2], lines: (s) => [{ text: si(C1.elements[0].flows[0], 'N'), domain: 'translational' }, { text: C1.summary(s), domain: 'thermal' }] },
      ],
    };
  },
};

// ------------------------------------------------------------------------------------------

const quarterCar: SceneDef = {
  id: 'quarter-car',
  name: 'Quarter-car suspension',
  summary: 'One corner of a car crossing a 60 mm bump at 8 m/s: 300 kg body, 40 kg wheel, 20 kN/m coil spring, 1.5 kN·s/m damper and a 200 kN/m tyre. Body bounce near 1.2 Hz, wheel hop near 12 Hz.',
  tip: 'Halve the shock absorber damping and watch the body keep bouncing; double it and the ride gets harsher (higher peak body acceleration).',
  h: 5e-4,
  method: 'trap',
  defaultSelection: 'CS',
  create() {
    const b = new ModelBuilder();
    const R1 = roadProfile(b, 'R1', 'Road bump', 'v.road');
    const KT = linearSpring(b, 'KT', 'Tyre', 'v.road', 'v.wheel', 200e3);
    const MU = mass(b, 'MU', 'Wheel and hub (unsprung)', 'v.wheel', 40);
    const KS = linearSpring(b, 'KS', 'Coil spring', 'v.wheel', 'v.body', 20e3);
    const CS = linearDamper(b, 'CS', 'Shock absorber', 'v.wheel', 'v.body', 1500);
    const MS = mass(b, 'MS', 'Body corner (sprung)', 'v.body', 300);
    const p = (k: string) => R1.params.find((x) => x.key === k)!.value;
    const bumpRel = (s: Simulator) => p('L') / 2 - p('speed') * (s.t - p('t0'));
    return {
      nodes: b.nodes, elements: b.elements(), components: b.components, initial: initialFor(b),
      traces: [
        { label: 'Body acceleration', unit: 'm/s²', domain: 'translational', get: () => MS.acceleration() },
        { label: 'Suspension travel', unit: 'mm', domain: 'translational', get: () => KS.deflection() * 1000 },
        { label: 'Tyre load change', unit: 'N', domain: 'translational', get: () => KT.force() },
      ],
      camera: { pos: [17, 11, 21], target: [0, 5, 0] },
      items: [{
        kind: 'quarterCar', component: 'MS', pos: [0, 0, 0],
        opts: { tire: 'KT', wheel: 'MU', body: 'MS', spring: 'KS', damper: 'CS', gain: 20 },
        drive: (s) => ({ xs: MS.position(), xu: MU.position(), roadH: R1.height(s), bump: bumpRel(s), bumpLen: p('L'), bumpH: p('h'), speed: p('speed') }),
      }],
      wires: [],
      labels: [
        { component: 'MS', anchor: [-1, 10.6, 0], lines: () => [{ text: si(MS.position() * 1000, 'mm'), domain: 'translational' }, { text: si(MS.acceleration(), 'm/s²'), domain: 'translational' }] },
        { component: 'MU', anchor: [2.6, 4.2, 0], lines: () => [{ text: si(MU.position() * 1000, 'mm'), domain: 'translational' }] },
        { component: 'CS', anchor: [-0.6, 6.2, -2.6], lines: () => [{ text: si(CS.elements[0].flows[0], 'N'), domain: 'translational' }] },
        { component: 'R1', anchor: [6, 1.6, 2.4], lines: (s) => [{ text: si(R1.height(s) * 1000, 'mm'), domain: 'translational' }] },
      ],
    };
  },
};

// ------------------------------------------------------------------------------------------

/** Motor + 50 : 1 reduction + thermal path, shared by the joint scenes. */
function jointDrive(b: ModelBuilder, j: string, ambientNode: string) {
  const M = dcMotor(b, `M${j}`, `Joint ${j} motor`, { p: `m${j}.p`, n: 'gnd', shaft: `shaft${j}.m`, heat: `th.w${j}` });
  setParams(M, { k: 0.035, R: 1.2 });
  const G = gearbox(b, `G${j}`, `Joint ${j} reduction`, `shaft${j}.m`, `shaft${j}.out`, 50);
  heatMass(b, `W${j}`, `Joint ${j} winding`, `th.w${j}`, 4.2);
  thermalResistance(b, `RT${j}`, `Joint ${j} case to air`, `th.w${j}`, ambientNode, 12);
  return { M, G };
}

const robotJoint: SceneDef = {
  id: 'robot-joint',
  name: 'Robot joint (PID servo)',
  summary: 'One robot joint: a digital PID servo drive powers a DC motor through a 50 : 1 reduction to lift a 1.2 kg arm against gravity. It steps to 60° at 0.5 s and back at 3.5 s.',
  tip: 'Set Ki to 0 and the arm settles short of 60° (gravity droop). Raise Kp until it overshoots, then add Kd to calm it.',
  h: 5e-4,
  method: 'trap',
  defaultSelection: 'SD1',
  create() {
    const b = new ModelBuilder();
    const SD = servoDrive(b, 'SD1', 'Servo drive (PID)', { p: 'm1.p', n: 'gnd', sense: 'shaft1.out' });
    const { M, G } = jointDrive(b, '1', 'th.a');
    const L1 = robotLink(b, 'L1', 'Arm link', 'shaft1.out', { m: 1.2, l: 0.15, theta0: 0 });
    const A1 = ambient(b, 'A1', 'Ambient', 'th.a', 22);
    const angle = () => L1.angle() / DEG;
    return {
      nodes: b.nodes, elements: b.elements(), components: b.components, initial: initialFor(b),
      traces: [
        { label: 'Joint angle', unit: '°', domain: 'rotational', get: angle },
        { label: 'Tracking error', unit: '°', domain: 'rotational', get: () => (SD.pid.ref - SD.pid.meas) / DEG },
        { label: 'Motor current', unit: 'A', domain: 'electrical', get: () => M.current() },
      ],
      camera: { pos: [13, 13, 25], target: [-2, 5, 0] },
      items: [
        { kind: 'device', component: 'SD1', pos: [-12, 0, 0], opts: { label: 'SERVO', sub: 'PID · H-bridge', w: 3.6, h: 1.8, d: 2.4 }, drive: () => ({ level: Math.abs(SD.pid.u) / 12 }) },
        { kind: 'motor', component: 'M1', pos: [-5, 6, 0], drive: (s) => ({ omega: M.omega(s), heat: M.temperature(s) - A1.params[0].value }) },
        { kind: 'gearbox', component: 'G1', pos: [2.4, 6, 0], drive: (s) => ({ win: s.effort(G.ports[0].node), wout: s.effort(G.ports[1].node) }) },
        { kind: 'link', component: 'L1', pos: [6.2, 6, 0], opts: { post: 5.3, length: 5 }, drive: () => ({ theta: L1.angle() }) },
        { kind: 'ambient', component: 'A1', pos: [-5, 10.6, -2.5] },
      ],
      wires: [
        { domain: 'electrical', points: arc([-13, 1.9, 0.3], [-7.4, 6.7, 0.7], 1.5), flow: () => M.current(), scale: 1 },
        { domain: 'electrical', points: arc([-7.4, 5.3, -0.7], [-11, 1.9, -0.3], 1.2), flow: () => M.current(), scale: 1 },
        { domain: 'electrical', points: arc([6.2, 6.8, 0.7], [-12.8, 1.9, -0.9], 2.5) },
        { domain: 'thermal', points: [[-5, 7.7, 0], [-5, 9.0, -1.2], [-5, 10.4, -2.4]], flow: () => b.components.find((c) => c.id === 'RT1')!.elements[0].flows[0], scale: 1 },
      ],
      labels: [
        { component: 'SD1', anchor: [-12, 3.4, 0], lines: () => [{ text: `${(SD.pid.meas / DEG).toFixed(1)}° → ${(SD.pid.ref / DEG).toFixed(0)}°`, domain: 'rotational' }, { text: si(SD.pid.u, 'V'), domain: 'electrical' }] },
        { component: 'M1', anchor: [-5, 9.2, 0], lines: (s) => [{ text: si(M.current(), 'A'), domain: 'electrical' }, { text: si(toRpm(M.omega(s)), 'rpm'), domain: 'rotational' }, { text: si(toCelsius(M.temperature(s)), '°C'), domain: 'thermal' }] },
        { component: 'L1', anchor: [8.5, 9.8, 0], lines: () => [{ text: si(angle(), '°'), domain: 'rotational' }] },
      ],
    };
  },
};

// ------------------------------------------------------------------------------------------

/** Pick-and-place cycle: [t, base yaw, shoulder, forearm (absolute), grip]. */
const PICK_PLACE = [
  { t: 0.0, q: [0, 50, -20, 0] },
  { t: 0.4, q: [0, 50, -20, 0] },
  { t: 1.4, q: [32.9, 45, -40, 0] },
  { t: 1.9, q: [32.9, 34.5, -58.2, 0] },
  { t: 2.3, q: [32.9, 34.5, -58.2, 1] },
  { t: 2.8, q: [32.9, 45, -40, 1] },
  { t: 4.0, q: [-32.9, 45, -40, 1] },
  { t: 4.5, q: [-32.9, 34.5, -58.2, 1] },
  { t: 4.9, q: [-32.9, 34.5, -58.2, 0] },
  { t: 5.4, q: [-32.9, 45, -40, 0] },
  { t: 6.6, q: [0, 50, -20, 0] },
].map((w) => ({ t: w.t, q: [w.q[0] * DEG, w.q[1] * DEG, w.q[2] * DEG, w.q[3]] }));

const robotArm: SceneDef = {
  id: 'robot-arm',
  name: 'Robot arm pick-and-place',
  summary: 'A 3-axis palletizing arm with a parallelogram linkage moves a part between two stands. Each joint has its own PID servo, DC motor and 50 : 1 reduction; gravity loads the shoulder and forearm.',
  tip: 'Lower the shoulder Kp (SD2) and watch the tracking lag grow during the fast moves. The Joint 2 current shows the gravity hold torque.',
  h: 5e-4,
  method: 'trap',
  defaultSelection: 'SD2',
  create() {
    const b = new ModelBuilder();
    const traj = trajectory(PICK_PLACE);
    const home = PICK_PLACE[0].q;
    const SD = [0, 1, 2].map((j) => servoDrive(b, `SD${j + 1}`, `Joint ${j + 1} servo`, { p: `m${j + 1}.p`, n: 'gnd', sense: `shaft${j + 1}.out` }, { theta0: home[j], reference: (t) => traj(t)[j] }));
    const J = ['1', '2', '3'].map((j) => jointDrive(b, j, 'th.a'));
    const L = [
      robotLink(b, 'L1', 'Turret (base yaw)', 'shaft1.out', { m: 3, l: 0.1, theta0: home[0], gravity: false }),
      robotLink(b, 'L2', 'Upper arm', 'shaft2.out', { m: 1.2, l: 0.15, theta0: home[1] }),
      robotLink(b, 'L3', 'Forearm and gripper', 'shaft3.out', { m: 0.6, l: 0.125, theta0: home[2] }),
    ];
    ambient(b, 'A1', 'Ambient', 'th.a', 22);
    const deg = (k: number) => L[k].angle() / DEG;
    return {
      nodes: b.nodes, elements: b.elements(), components: b.components, initial: initialFor(b),
      traces: [
        { label: 'Shoulder angle', unit: '°', domain: 'rotational', get: () => deg(1) },
        { label: 'Forearm angle', unit: '°', domain: 'rotational', get: () => deg(2) },
        { label: 'Shoulder motor current', unit: 'A', domain: 'electrical', get: () => J[1].M.current() },
      ],
      camera: { pos: [19, 15, 21], target: [2, 4, 0] },
      items: [
        {
          kind: 'robotArm', component: 'L2', pos: [0, 0, 0], opts: { j1: 'L1', j2: 'L2', j3: 'L3' },
          drive: (s) => {
            const q = traj(s.t);
            return { q1: L[0].angle(), q2: L[1].angle(), q3: L[2].angle(), grip: q[3], carry: s.t > 2.2 && s.t < 4.65, reset: s.t < 0.01 };
          },
        },
        ...SD.map((sd, j) => ({ kind: 'device' as const, component: sd.id, pos: [-10, 0, -4 + j * 4] as Vec3, opts: { label: `J${j + 1}`, sub: 'servo', w: 2.6, h: 1.4, d: 2 }, drive: () => ({ level: Math.abs(sd.pid.u) / 12 }) })),
      ],
      wires: SD.map((_sd, j) => ({ domain: 'electrical' as const, points: arc([-8.7, 1.5, -4 + j * 4], [-1.5, 2.0, -0.8 + j * 0.8], 1.4), flow: () => J[j].M.current(), scale: 1 })),
      labels: [
        {
          component: 'L2', anchor: [3, 12, 0], lines: () => [
            { text: `yaw ${deg(0).toFixed(1)}°`, domain: 'rotational' },
            { text: `shoulder ${deg(1).toFixed(1)}°`, domain: 'rotational' },
            { text: `forearm ${deg(2).toFixed(1)}°`, domain: 'rotational' },
          ],
        },
      ],
    };
  },
};

// ------------------------------------------------------------------------------------------

const rocketEngine: SceneDef = {
  id: 'rocket-engine',
  name: 'Rocket engine hot-fire',
  summary: 'A 2 kN pressure-fed LOX/ethanol engine on a test stand. 22 bar tanks feed the injectors through 1.5 m lines and main valves; the chamber runs near 15 bar with a 4 : 1 nozzle and a regeneratively cooled copper liner. The thrust frame rests on a load cell.',
  tip: 'Raise the combustion time lag τc on E1 from 2 ms to 6 ms and the chamber pressure starts to chug (a low-frequency instability near 70 Hz). Change one tank pressure to move the mixture ratio.',
  h: 2.5e-4,
  method: 'be',
  defaultSelection: 'E1',
  create() {
    const b = new ModelBuilder();
    const TO = pressureTank(b, 'TO', 'LOX tank', 'fl.ox.tank', 22);
    const TF = pressureTank(b, 'TF', 'Ethanol tank', 'fl.fu.tank', 22);
    const LO = feedLine(b, 'LO', 'LOX feed line', 'fl.ox.tank', 'fl.ox.line', { L: 1.5, D: 0.012, f: 0.03, rho: 1141 });
    const LF = feedLine(b, 'LF', 'Fuel feed line', 'fl.fu.tank', 'fl.fu.line', { L: 1.5, D: 0.012, f: 0.03, rho: 789 });
    const VO = valve(b, 'VO', 'LOX main valve', 'fl.ox.line', 'fl.ox.inj', { cdA: 80e-6, rho: 1141, open: 0.5, close: 3.5, ramp: 0.08 });
    const VF = valve(b, 'VF', 'Fuel main valve', 'fl.fu.line', 'fl.fu.inj', { cdA: 80e-6, rho: 789, open: 0.45, close: 3.55, ramp: 0.08 });
    // Injector manifolds: their compliance couples chamber pressure back into the feed (chug).
    fluidVolume(b, 'MO', 'LOX injector manifold', 'fl.ox.inj', { V: 3e-4, a: 200 });
    fluidVolume(b, 'MF', 'Fuel injector manifold', 'fl.fu.inj', { V: 3e-4, a: 200 });
    const E1 = thrustChamber(b, 'E1', 'Thrust chamber', { ox: 'fl.ox.inj', fuel: 'fl.fu.inj', wall: 'th.wall' });
    const W1 = heatMass(b, 'W1', 'Copper liner', 'th.wall', 770);
    const C1 = ambient(b, 'C1', 'Fuel coolant inlet', 'th.cool', 20);
    // Regenerative jacket: the fuel flowing through the cooling channels carries the wall heat
    // away. Its film coefficient follows the fuel flow (Dittus–Boelter, h ∝ ṁ^0.8).
    const pH = param({ key: 'hA', label: 'Coolant-side h·A at full fuel flow', symbol: 'hA', value: 600, unit: 'W/K', source: 'prior', min: 0 });
    const jacket = new Conductance('RJ.hA', W1.ports[0].node, C1.ports[0].node, 'thermal', () => pH.value * Math.max(0.03, Math.pow(Math.max(0, E1.state.mdotFu) / 0.36, 0.8)));
    b.add<Component>({
      id: 'RJ', name: 'Regenerative cooling jacket', type: 'lib://propulsion/regen-jacket', group: 'Thermal',
      ports: [{ name: 'wall', domain: 'thermal', node: W1.ports[0].node }, { name: 'coolant', domain: 'thermal', node: C1.ports[0].node }],
      params: [pH], elements: [jacket],
      summary: () => si(jacket.flows[0], 'W'),
      derived: () => [
        { label: 'Heat to coolant', value: si(jacket.flows[0], 'W') },
        { label: 'Coolant temperature rise', value: E1.state.mdotFu > 0.01 ? si(jacket.flows[0] / (E1.state.mdotFu * 2440), 'K') : '—' },
      ],
    });
    // Thrust stand: engine and frame (25 kg) on a 5 MN/m load cell, so the reading rings at ignition.
    const TS = mass(b, 'TS', 'Engine and thrust frame', 'v.stand', 25);
    const LC = linearSpring(b, 'LC', 'Load cell', 'v.stand', 'gnd', 5e6);
    linearDamper(b, 'LD', 'Mount damping', 'v.stand', 'gnd', 1100);
    const thrustEl = new FlowSource('TL.F', TS.ports[0].node, GROUND, 'translational', () => E1.state.thrust);
    b.add<Component>({
      id: 'TL', name: 'Thrust on the frame', type: 'lib://propulsion/thrust-load', group: 'Translational',
      ports: [{ name: 'frame', domain: 'translational', node: TS.ports[0].node }], params: [], elements: [thrustEl as Element],
      summary: () => si(E1.state.thrust, 'N'),
    });
    const s0 = E1.state;
    const linerC = (s: Simulator) => toCelsius(s.effort(W1.ports[0].node));
    return {
      nodes: b.nodes, elements: b.elements(), components: b.components, initial: initialFor(b),
      traces: [
        { label: 'Chamber pressure', unit: 'bar', domain: 'fluid', get: () => s0.pc / 1e5, min: 0, hwKey: 'pc' },
        { label: 'Load cell thrust', unit: 'N', domain: 'translational', get: () => LC.force(), hwKey: 'thrust' },
        { label: 'Liner temperature', unit: '°C', domain: 'thermal', get: linerC },
      ],
      camera: { pos: [15, 13, 25], target: [-2, 2.5, 0] },
      items: [
        { kind: 'teststand', component: 'TS', pos: [0, 0, 0], opts: { loadcell: 'LC' } },
        { kind: 'thrustchamber', component: 'E1', pos: [1.5, 3, 0], opts: { post: 3, rated: 2000 }, drive: (s) => ({ thrust: s0.thrust, heat: s.effort(W1.ports[0].node) - 295 }) },
        { kind: 'tank', component: 'TO', pos: [-12, 0, -5], opts: { label: 'LOX', sub: '22 bar', tint: '#9FC6FF' }, drive: (s) => ({ p: s.effort(TO.ports[0].node) }) },
        { kind: 'tank', component: 'TF', pos: [-12, 0, 5], opts: { label: 'ETHANOL', sub: '22 bar', tint: '#F2C14E' }, drive: (s) => ({ p: s.effort(TF.ports[0].node) }) },
        { kind: 'valve', component: 'VO', pos: [-6, 1, -3.2], opts: { post: 0.6 }, drive: () => ({ open: VO.opening() }) },
        { kind: 'valve', component: 'VF', pos: [-6, 1, 3.2], opts: { post: 0.6 }, drive: () => ({ open: VF.opening() }) },
      ],
      wires: [
        { domain: 'fluid', points: arc([-10.5, 0.9, -5], [-7.3, 1, -3.2], 0.6), flow: () => LO.flow(), scale: 0.4 },
        { domain: 'fluid', points: arc([-10.5, 0.9, 5], [-7.3, 1, 3.2], 0.6), flow: () => LF.flow(), scale: 0.3 },
        { domain: 'fluid', points: [[-4.7, 1, -3.2], [-3.2, 1, -3.0], [-2.2, 2.4, -1.4], [-1.8, 3.55, -0.4], [-1.3, 3.55, 0]], flow: () => VO.flow(), scale: 0.4 },
        { domain: 'fluid', points: [[-4.7, 1, 3.2], [-3.2, 1, 3.0], [-2.2, 1.8, 1.4], [-1.8, 2.45, 0.4], [-1.3, 2.45, 0]], flow: () => VF.flow(), scale: 0.3 },
        { domain: 'thermal', points: arc([1.5, 4.5, 0], [-1.3, 2.6, 0.6], 1.2), flow: () => jacket.flows[0], scale: 5e4 },
      ],
      labels: [
        { component: 'E1', anchor: [4.2, 7.0, 0], lines: () => [{ text: si(s0.thrust, 'N'), domain: 'translational' }, { text: si(s0.pc / 1e5, 'bar'), domain: 'fluid' }, { text: s0.burning ? `O/F ${s0.mr.toFixed(2)} · Isp ${s0.isp.toFixed(0)} s` : 'not burning' }] },
        { component: 'LC', anchor: [-4.2, 4.4, 2.6], lines: () => [{ text: si(LC.force(), 'N'), domain: 'translational' }] },
        { component: 'TO', anchor: [-12, 7.4, -5], lines: (s) => [{ text: si(s.effort(TO.ports[0].node) / 1e5, 'bar'), domain: 'fluid' }, { text: si(TO.outflow(), 'kg/s'), domain: 'fluid' }] },
        { component: 'TF', anchor: [-12, 7.4, 5], lines: (s) => [{ text: si(s.effort(TF.ports[0].node) / 1e5, 'bar'), domain: 'fluid' }, { text: si(TF.outflow(), 'kg/s'), domain: 'fluid' }] },
        { component: 'VO', anchor: [-6.5, 2.4, -4.6], lines: () => [{ text: VO.summary() }] },
        { component: 'VF', anchor: [-6.5, 2.4, 4.6], lines: () => [{ text: VF.summary() }] },
        { component: 'W1', anchor: [1.0, 4.6, 2.6], lines: (s) => [{ text: si(linerC(s), '°C'), domain: 'thermal' }] },
      ],
    };
  },
};

// ------------------------------------------------------------------------------------------

const pumpLoop: SceneDef = {
  id: 'pump-loop',
  name: 'Hydraulic lift (pump loop)',
  summary: 'A 12 V motor turns a gear pump through a 20 : 1 reduction. Oil from the reservoir lifts a 10 kg load on a 16 mm cylinder until the valve closes at 3.3 s; then the pump dead-heads into a small bleed orifice.',
  tip: 'Watch pump pressure and motor current climb after the valve closes: this is why real circuits carry a relief valve. Toggle S1 to stop the motor, or open the valve again from its inspector.',
  h: 5e-4,
  method: 'be',
  defaultSelection: 'P1',
  create() {
    const b = new ModelBuilder();
    const B1 = battery(b, 'B1', 'Battery', 'b.p', 'gnd', 12, 0.1);
    const S1 = switchPart(b, 'S1', 'Switch', 'b.p', 'm.p', true);
    const M1 = dcMotor(b, 'M1', 'Pump motor', { p: 'm.p', n: 'gnd', shaft: 'shaft.m', heat: 'th.w' });
    heatMass(b, 'W1', 'Winding mass', 'th.w', 4.2);
    const R1 = thermalResistance(b, 'R1', 'Case to air', 'th.w', 'th.a', 18);
    const A1 = ambient(b, 'A1', 'Ambient', 'th.a', 22);
    const G1 = gearbox(b, 'G1', 'Reduction', 'shaft.m', 'shaft.p', 20);
    const P1 = pdPump(b, 'P1', 'Gear pump', { shaft: 'shaft.p', inlet: 'fl.tank', outlet: 'fl.p' });
    setParams(P1, { D: 2e-7, rho: 870, slip: 2e-10 });
    atmosphere(b, 'T1', 'Oil reservoir', 'fl.tank');
    const V1 = valve(b, 'V1', 'Lift valve', 'fl.p', 'fl.cap', { cdA: 2e-6, rho: 870, open: 0.3, close: 3.3, ramp: 0.05 });
    const O1 = orifice(b, 'O1', 'Bleed orifice', 'fl.p', 'fl.tank', 0.05e-6, 870);
    const H1 = hydraulicCylinder(b, 'H1', 'Lift cylinder', { cap: 'fl.cap', ret: 'fl.tank', rod: 'v.rod' });
    setParams(H1, { A: 2e-4 });
    const L1 = mass(b, 'L1', 'Load', 'v.rod', 10);
    forceSource(b, 'F1', 'Weight of the load', 'v.rod', -98.1);
    const gauge = (s: Simulator) => (s.effort(P1.ports[2].node) - ATM) / 1e5;
    return {
      nodes: b.nodes, elements: b.elements(), components: b.components, initial: initialFor(b),
      traces: [
        { label: 'Pump pressure (gauge)', unit: 'bar', domain: 'fluid', get: gauge, hwKey: 'p' },
        { label: 'Load height', unit: 'mm', domain: 'translational', get: () => L1.position() * 1000 },
        { label: 'Motor current', unit: 'A', domain: 'electrical', get: () => M1.current(), min: 0 },
      ],
      camera: { pos: [10, 17, 30], target: [1, 3, 0] },
      items: [
        { kind: 'battery', component: 'B1', pos: [-18, 0, -3], opts: { label: '12 V' } },
        { kind: 'switch', component: 'S1', pos: [-13, 0, 4], drive: () => ({ closed: S1.state.closed }) },
        { kind: 'motor', component: 'M1', pos: [-8, 6, 0], drive: (s) => ({ omega: M1.omega(s), heat: M1.temperature(s) - A1.params[0].value }) },
        { kind: 'gearbox', component: 'G1', pos: [-0.6, 6, 0], drive: (s) => ({ win: s.effort(G1.ports[0].node), wout: s.effort(G1.ports[1].node) }) },
        { kind: 'pump', component: 'P1', pos: [4.2, 6, 0], opts: { post: 4.5 }, drive: (s) => ({ omega: s.effort(P1.ports[0].node) }) },
        { kind: 'reservoir', component: 'T1', pos: [9, 0, 7], opts: { rot: Math.PI } },
        { kind: 'valve', component: 'V1', pos: [10, 1, -5], opts: { post: 0.6 }, drive: () => ({ open: V1.opening() }) },
        { kind: 'orifice', component: 'O1', pos: [7.5, 1, 2] },
        { kind: 'hydcylinder', component: 'H1', pos: [15, 3.2, -5], opts: { vertical: true, gain: 15 }, drive: () => ({ x: L1.position() }) },
        { kind: 'mass', component: 'L1', pos: [15, 6.6, -5], opts: { size: 2, label: '10 kg', gain: 15 }, drive: () => ({ x: L1.position() }) },
        { kind: 'ambient', component: 'A1', pos: [-8, 10.6, -2.5] },
      ],
      wires: [
        { domain: 'electrical', points: arc([-19.2, 3.75, -3], [-14.1, 0.75, 4], 1.2), flow: () => B1.current(), scale: 1 },
        { domain: 'electrical', points: arc([-11.9, 0.75, 4], [-10.4, 6.7, 0.7], 1.0), flow: () => M1.current(), scale: 1 },
        { domain: 'electrical', points: arc([-10.4, 5.3, -0.7], [-16.8, 3.75, -3], 1.2), flow: () => M1.current(), scale: 1 },
        { domain: 'fluid', points: arc([4.8, 5.8, -1.5], [8.7, 1, -5], 1.0), flow: () => P1.delivered() - O1.elements[0].flows[0], scale: 0.01 },
        { domain: 'fluid', points: arc([11.3, 1, -5], [14.2, 1.0, -5], 0.5), flow: () => V1.flow(), scale: 0.01 },
        { domain: 'fluid', points: arc([4.8, 5.8, -1.5], [6.3, 1, 2], 0.8), flow: () => O1.elements[0].flows[0], scale: 0.01 },
        { domain: 'fluid', points: arc([8.7, 1, 2], [8.2, 1.2, 5.8], 0.6), flow: () => O1.elements[0].flows[0], scale: 0.01 },
        { domain: 'fluid', points: arc([7.3, 0.6, 7], [4.8, 5.8, 1.5], 1.2), flow: () => P1.delivered(), scale: 0.01 },
        { domain: 'fluid', points: arc([14.2, 3.8, -5], [10.2, 1.6, 5.9], 1.5), flow: () => -H1.elements[0].flows[1], scale: 0.01 },
        { domain: 'thermal', points: [[-8, 7.7, 0], [-8, 9.0, -1.2], [-8, 10.4, -2.4]], flow: () => R1.elements[0].flows[0], scale: 1 },
      ],
      labels: [
        { component: 'M1', anchor: [-8, 9.2, 0], lines: (s) => [{ text: si(M1.current(), 'A'), domain: 'electrical' }, { text: si(toRpm(M1.omega(s)), 'rpm'), domain: 'rotational' }, { text: si(toCelsius(M1.temperature(s)), '°C'), domain: 'thermal' }] },
        { component: 'P1', anchor: [4.2, 8.4, 0], lines: (s) => [{ text: si(P1.delivered(), 'kg/s'), domain: 'fluid' }, { text: si(gauge(s), 'bar'), domain: 'fluid' }] },
        { component: 'V1', anchor: [10, 2.7, -5], lines: () => [{ text: V1.summary() }] },
        { component: 'L1', anchor: [15, 10.2, -5], lines: () => [{ text: si(L1.position() * 1000, 'mm'), domain: 'translational' }, { text: si(H1.elements[0].flows[2] ? -H1.elements[0].flows[2] : 0, 'N'), domain: 'translational' }] },
      ],
    };
  },
};

export const EXT_SCENES: SceneDef[] = [springMassDamper, quarterCar, robotJoint, robotArm, rocketEngine, pumpLoop];
