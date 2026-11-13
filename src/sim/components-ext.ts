import { type Domain, type Element, GROUND, Simulator } from './core';
import { Capacitance, Conductance, Diode, EffortSource, HeatingResistor, Inductance, Logic, TwoPort } from './elements';
import { FlowSource, Gyrator, GravityLink, PidLogic, SqrtFlow, ThrustChamber } from './elements-ext';
import { type Component, get, type Group, type ModelBuilder, param, type Param } from './components';
import { si, toCelsius, toRpm } from './units';

const port = (name: string, domain: Domain, node: number) => ({ name, domain, node });
const comp = <T extends object>(c: Component & T) => c;

// ================================================================ electrical

export function currentSource(b: ModelBuilder, id: string, name: string, p: string, n: string, amps = 0.1) {
  const P = b.node(p, 'electrical'), N = b.node(n, 'electrical');
  const pI = param({ key: 'I', label: 'Current', symbol: 'I', value: amps, unit: 'A', source: 'datasheet', event: true });
  const el = new FlowSource(`${id}.I`, P, N, 'electrical', get(pI));
  return b.add(comp({
    id, name, type: 'lib://sources/current', group: 'Electrical' as Group,
    ports: [port('p', 'electrical', P), port('n', 'electrical', N)], params: [pI], elements: [el] as Element[],
    summary: () => si(pI.value, 'A'),
    derived: (s: Simulator) => [{ label: 'Voltage across', value: si(s.effort(P) - s.effort(N), 'V') }, { label: 'Power delivered', value: si(pI.value * (s.effort(P) - s.effort(N)), 'W') }],
  }));
}

/** Sine or square voltage source with 50 Ω output resistance. */
export function functionGenerator(b: ModelBuilder, id: string, name: string, p: string, n: string) {
  const P = b.node(p, 'electrical'), N = b.node(n, 'electrical'), I = b.node(`${id}.int`, 'electrical');
  const pA = param({ key: 'A', label: 'Amplitude', symbol: 'Vₚ', value: 5, unit: 'V', source: 'datasheet' });
  const pF = param({ key: 'f', label: 'Frequency', symbol: 'f', value: 2, unit: 'Hz', source: 'datasheet', min: 0 });
  const pO = param({ key: 'offset', label: 'Offset', symbol: 'V₀', value: 0, unit: 'V', source: 'datasheet' });
  const pS = param({ key: 'square', label: 'Square wave (1) or sine (0)', symbol: 'shape', value: 0, unit: '', source: 'datasheet' });
  const wave = (t: number) => {
    const ph = Math.sin(2 * Math.PI * pF.value * t);
    return pO.value + pA.value * (pS.value >= 0.5 ? (ph >= 0 ? 1 : -1) : ph);
  };
  const src = new EffortSource(`${id}.E`, I, N, 'electrical', wave);
  const r = new Conductance(`${id}.Rout`, I, P, 'electrical', () => 1 / 50);
  return b.add(comp({
    id, name, type: 'lib://sources/function-generator', group: 'Electrical' as Group,
    ports: [port('p', 'electrical', P), port('n', 'electrical', N)], params: [pA, pF, pO, pS], elements: [src, r] as Element[],
    summary: (s: Simulator) => si(s.effort(P) - s.effort(N), 'V'),
    derived: (s: Simulator) => [{ label: 'Output', value: si(s.effort(P) - s.effort(N), 'V') }, { label: 'Current out', value: si(r.flows[0], 'A') }],
  }));
}

export function rectifierDiode(b: ModelBuilder, id: string, name: string, a: string, k: string) {
  const A = b.node(a, 'electrical'), K = b.node(k, 'electrical');
  const d = new Diode(`${id}.pn`, A, K, 2.5e-9, 1.75);
  return b.add(comp({
    id, name, type: 'lib://semiconductors/rectifier-1n4007', group: 'Electrical' as Group,
    ports: [port('anode', 'electrical', A), port('cathode', 'electrical', K)], params: [], elements: [d] as Element[],
    current: () => d.flows[0],
    summary: () => si(d.flows[0], 'A'),
    derived: (s: Simulator) => [{ label: 'Forward voltage', value: si(s.effort(A) - s.effort(K), 'V') }, { label: 'Current', value: si(d.flows[0], 'A') }],
  }));
}

/** Wirewound power resistor that heats up and sends its I²R loss to a thermal port. */
export function powerResistor(b: ModelBuilder, id: string, name: string, a: string, z: string, heat: string, R = 10) {
  const A = b.node(a, 'electrical'), Z = b.node(z, 'electrical'), H = b.node(heat, 'thermal');
  const pR = param({ key: 'R', label: 'Resistance @ 22 °C', symbol: 'R', value: R, unit: 'Ω', sigma: 0.05 * R, source: 'datasheet', min: 1e-4 });
  const pA = param({ key: 'alpha', label: 'Temperature coefficient', symbol: 'α', value: 2e-4, unit: '1/K', source: 'datasheet' });
  const el = new HeatingResistor(`${id}.R`, A, Z, H, get(pR), get(pA), 295.15);
  return b.add(comp({
    id, name, type: 'lib://passives/power-resistor', group: 'Electrical' as Group,
    ports: [port('a', 'electrical', A), port('b', 'electrical', Z), port('heat', 'thermal', H)], params: [pR, pA], elements: [el] as Element[],
    summary: () => si(-el.flows[2], 'W'),
    derived: (s: Simulator) => [{ label: 'Current', value: si(el.flows[0], 'A') }, { label: 'Dissipation', value: si(-el.flows[2], 'W') }, { label: 'Body temperature', value: si(toCelsius(s.effort(H)), '°C') }],
  }));
}

// ================================================================ control

/**
 * Position servo drive: a digital PID (one sample per solver step) reads the joint speed at its
 * sense port, integrates it to an angle, and drives the motor with a clamped voltage.
 * The reference steps between two angles; scenes can supply their own trajectory.
 */
export function servoDrive(
  b: ModelBuilder, id: string, name: string, ports: { p: string; n: string; sense: string },
  opts: { reference?: (t: number) => number; theta0?: number; target?: number; vmax?: number } = {},
) {
  const P = b.node(ports.p, 'electrical'), N = b.node(ports.n, 'electrical'), S = b.node(ports.sense, 'rotational');
  const deg = Math.PI / 180;
  const pKp = param({ key: 'kp', label: 'Proportional gain', symbol: 'Kp', value: 40, unit: 'V/rad', source: 'sysid', min: 0 });
  const pKi = param({ key: 'ki', label: 'Integral gain', symbol: 'Ki', value: 20, unit: 'V/(rad·s)', source: 'sysid', min: 0 });
  const pKd = param({ key: 'kd', label: 'Derivative gain', symbol: 'Kd', value: 1.2, unit: 'V·s/rad', source: 'sysid', min: 0 });
  const pV = param({ key: 'vmax', label: 'Supply voltage', symbol: 'Vmax', value: opts.vmax ?? 12, unit: 'V', source: 'datasheet', min: 0.1 });
  const pT0 = param({ key: 'theta0', label: 'Start angle', symbol: 'θ₀', value: opts.theta0 ?? 0, unit: '°', scale: deg, source: 'cad' });
  const pT1 = param({ key: 'target', label: 'Step target', symbol: 'θ*', value: opts.target ?? 60 * deg, unit: '°', scale: deg, source: 'cad' });
  const pTs = param({ key: 'tstep', label: 'Step time', symbol: 'tₛ', value: 0.5, unit: 's', source: 'cad', min: 0 });
  const ref = opts.reference ?? ((t: number) => (t >= pTs.value && t < pTs.value + 3 ? pT1.value : pT0.value));
  const logic = new PidLogic(`${id}.pid`, S, { kp: get(pKp), ki: get(pKi), kd: get(pKd), vmax: get(pV), ratio: () => 1, theta0: get(pT0) }, ref);
  const src = new EffortSource(`${id}.bridge`, P, N, 'electrical', () => logic.s.u);
  return b.add(comp({
    id, name, type: 'lib://control/servo-drive-pid', group: 'Control' as Group,
    ports: [port('p', 'electrical', P), port('n', 'electrical', N), port('sense', 'rotational', S)],
    params: [pKp, pKi, pKd, pV, pT0, pT1, pTs], elements: [logic, src] as Element[],
    pid: logic.s,
    summary: () => `${(logic.s.meas / deg).toFixed(1)}° → ${(logic.s.ref / deg).toFixed(0)}°`,
    derived: () => [
      { label: 'Reference', value: si(logic.s.ref / deg, '°') },
      { label: 'Measured angle', value: si(logic.s.meas / deg, '°') },
      { label: 'Error', value: si((logic.s.ref - logic.s.meas) / deg, '°') },
      { label: 'Drive voltage', value: si(logic.s.u, 'V') },
      { label: 'Saturated', value: logic.s.saturated ? 'yes' : 'no' },
    ],
  }));
}

// ================================================================ translational

/** Point mass. Tracks its own displacement so scenes can draw and plot it. */
export function mass(b: ModelBuilder, id: string, name: string, node: string, m = 1) {
  const V = b.node(node, 'translational');
  const pM = param({ key: 'm', label: 'Mass', symbol: 'm', value: m, unit: 'kg', sigma: 0.01 * m, source: 'cad', min: 1e-6 });
  const pos = { x: 0, last: 0 };
  const el = new Capacitance(`${id}.m`, V, GROUND, 'translational', get(pM));
  const track = new Logic(`${id}.x`, (e, t) => { pos.x += (t - pos.last) * e(V); pos.last = t; return false; }, () => { pos.x = 0; pos.last = 0; });
  return b.add(comp({
    id, name, type: 'lib://mechanical/mass', group: 'Translational' as Group,
    ports: [port('v', 'translational', V)], params: [pM], elements: [el, track] as Element[],
    position: () => pos.x,
    velocity: (s: Simulator) => s.effort(V),
    acceleration: () => el.flows[0] / pM.value,
    summary: () => si(pos.x, 'm'),
    derived: (s: Simulator) => [
      { label: 'Displacement', value: si(pos.x, 'm') },
      { label: 'Velocity', value: si(s.effort(V), 'm/s') },
      { label: 'Acceleration', value: si(el.flows[0] / pM.value, 'm/s²') },
      { label: 'Kinetic energy', value: si(el.stored((n) => s.effort(n)), 'J') },
    ],
  }));
}

export function linearSpring(b: ModelBuilder, id: string, name: string, a: string, z: string, k = 1000, preload = 0) {
  const A = b.node(a, 'translational'), Z = b.node(z, 'translational');
  const pK = param({ key: 'k', label: 'Stiffness', symbol: 'k', value: k, unit: 'N/m', sigma: 0.05 * k, source: 'datasheet', min: 1e-6 });
  const pF = param({ key: 'F0', label: 'Preload force', symbol: 'F₀', value: preload, unit: 'N', source: 'cad' });
  const el = new Inductance(`${id}.k`, A, Z, 'translational', () => 1 / pK.value, get(pF));
  return b.add(comp({
    id, name, type: 'lib://mechanical/spring', group: 'Translational' as Group,
    ports: [port('a', 'translational', A), port('b', 'translational', Z)], params: [pK, pF], elements: [el] as Element[],
    force: () => el.i,
    deflection: () => el.i / pK.value,
    summary: () => si(el.i, 'N'),
    derived: () => [{ label: 'Force', value: si(el.i, 'N') }, { label: 'Deflection', value: si(el.i / pK.value, 'm') }, { label: 'Stored energy', value: si(el.stored(), 'J') }],
  }));
}

export function linearDamper(b: ModelBuilder, id: string, name: string, a: string, z: string, c = 50) {
  const A = b.node(a, 'translational'), Z = b.node(z, 'translational');
  const pC = param({ key: 'c', label: 'Damping', symbol: 'c', value: c, unit: 'N·s/m', sigma: 0.1 * c, source: 'datasheet', min: 0 });
  const el = new Conductance(`${id}.c`, A, Z, 'translational', get(pC));
  return b.add(comp({
    id, name, type: 'lib://mechanical/damper', group: 'Translational' as Group,
    ports: [port('a', 'translational', A), port('b', 'translational', Z)], params: [pC], elements: [el] as Element[],
    summary: (s: Simulator) => si(el.flows[0] * (s.effort(A) - s.effort(Z)), 'W'),
    derived: (s: Simulator) => [{ label: 'Force', value: si(el.flows[0], 'N') }, { label: 'Power lost', value: si(el.flows[0] * (s.effort(A) - s.effort(Z)), 'W') }],
  }));
}

/** Constant force pushing on a node, e.g. gravity (F = −m·g) or a load. */
export function forceSource(b: ModelBuilder, id: string, name: string, node: string, F = -9.81) {
  const V = b.node(node, 'translational');
  const pF = param({ key: 'F', label: 'Force', symbol: 'F', value: F, unit: 'N', source: 'cad', event: true });
  const el = new FlowSource(`${id}.F`, V, GROUND, 'translational', get(pF));
  return b.add(comp({
    id, name, type: 'lib://mechanical/force', group: 'Translational' as Group,
    ports: [port('v', 'translational', V)], params: [pF], elements: [el] as Element[],
    summary: () => si(pF.value, 'N'),
    derived: (s: Simulator) => [{ label: 'Force', value: si(pF.value, 'N') }, { label: 'Power', value: si(pF.value * s.effort(V), 'W') }],
  }));
}

/** A road bump under a wheel: a raised-cosine profile of height h and length L at speed V. */
export function roadProfile(b: ModelBuilder, id: string, name: string, node: string) {
  const V = b.node(node, 'translational');
  const pH = param({ key: 'h', label: 'Bump height', symbol: 'h', value: 0.06, unit: 'mm', scale: 1e-3, source: 'cad', min: 0 });
  const pL = param({ key: 'L', label: 'Bump length', symbol: 'L', value: 0.8, unit: 'm', source: 'cad', min: 0.01 });
  const pV = param({ key: 'speed', label: 'Vehicle speed', symbol: 'V', value: 8, unit: 'm/s', source: 'cad', min: 0.01 });
  const pT = param({ key: 't0', label: 'Bump arrives at', symbol: 't₀', value: 1, unit: 's', source: 'cad', min: 0 });
  const xOf = (t: number) => pV.value * (t - pT.value);
  const height = (t: number) => { const x = xOf(t); return x > 0 && x < pL.value ? (pH.value / 2) * (1 - Math.cos((2 * Math.PI * x) / pL.value)) : 0; };
  const rate = (t: number) => { const x = xOf(t); return x > 0 && x < pL.value ? ((pH.value * Math.PI * pV.value) / pL.value) * Math.sin((2 * Math.PI * x) / pL.value) : 0; };
  const el = new EffortSource(`${id}.road`, V, GROUND, 'translational', rate);
  return b.add(comp({
    id, name, type: 'lib://mechanical/road-profile', group: 'Translational' as Group,
    ports: [port('v', 'translational', V)], params: [pH, pL, pV, pT], elements: [el] as Element[],
    height: (s: Simulator) => height(s.t),
    summary: (s: Simulator) => si(height(s.t), 'm'),
    derived: (s: Simulator) => [{ label: 'Road height', value: si(height(s.t), 'm') }, { label: 'Vertical speed', value: si(s.effort(V), 'm/s') }],
  }));
}

/** Rigid frame for translational parts: its node is the solver's fixed reference. */
export function anchor(b: ModelBuilder, id: string, name: string) {
  return b.add(comp({
    id, name, type: 'lib://reference/anchor', group: 'Translational' as Group,
    ports: [port('v', 'translational', GROUND)], params: [], elements: [] as Element[], summary: () => 'fixed',
  }));
}

/** Rack and pinion: v = R·ω, F = τ / R. */
export function rackPinion(b: ModelBuilder, id: string, name: string, shaft: string, rack: string, R = 0.02) {
  const W = b.node(shaft, 'rotational'), V = b.node(rack, 'translational');
  const pR = param({ key: 'R', label: 'Pinion pitch radius', symbol: 'R', value: R, unit: 'mm', scale: 1e-3, source: 'cad', min: 1e-5 });
  const el = new TwoPort(`${id}.mesh`, V, GROUND, W, GROUND, 'translational', 'rotational', get(pR));
  return b.add(comp({
    id, name, type: 'lib://transmissions/rack-pinion', group: 'Couplings' as Group,
    ports: [port('shaft', 'rotational', W), port('rack', 'translational', V)], params: [pR], elements: [el] as Element[],
    summary: (s: Simulator) => si(s.effort(V), 'm/s'),
    derived: (s: Simulator) => [{ label: 'Rack speed', value: si(s.effort(V), 'm/s') }, { label: 'Rack force', value: si(el.flows[0], 'N') }],
  }));
}

// ================================================================ rotational

/** Robot link on a joint: rotational inertia about the joint plus gravity on its centre of mass. */
export function robotLink(b: ModelBuilder, id: string, name: string, joint: string, opts: { m?: number; l?: number; theta0?: number; gravity?: boolean } = {}) {
  const W = b.node(joint, 'rotational');
  const deg = Math.PI / 180;
  const pM = param({ key: 'm', label: 'Link mass', symbol: 'm', value: opts.m ?? 0.5, unit: 'kg', sigma: 0.02, source: 'cad', min: 1e-4 });
  const pL = param({ key: 'l', label: 'Joint to centre of mass', symbol: 'l', value: opts.l ?? 0.15, unit: 'mm', scale: 1e-3, source: 'cad', min: 1e-4 });
  const pT = param({ key: 'theta0', label: 'Start angle above horizontal', symbol: 'θ₀', value: opts.theta0 ?? 0, unit: '°', scale: deg, source: 'cad' });
  const pG = param({ key: 'g', label: 'Gravity on (1) or off (0)', symbol: 'g', value: opts.gravity === false ? 0 : 1, unit: '', source: 'cad' });
  const inertia = new Capacitance(`${id}.J`, W, GROUND, 'rotational', () => pM.value * pL.value * pL.value * 1.33);
  const grav = new GravityLink(`${id}.g`, W, () => pM.value * pG.value, get(pL), get(pT));
  return b.add(comp({
    id, name, type: 'lib://robotics/link', group: 'Rotational' as Group,
    ports: [port('joint', 'rotational', W)], params: [pM, pL, pT, pG], elements: [inertia, grav] as Element[],
    angle: () => grav.theta,
    summary: () => si((grav.theta * 180) / Math.PI, '°'),
    derived: (s: Simulator) => [
      { label: 'Angle', value: si((grav.theta * 180) / Math.PI, '°') },
      { label: 'Joint speed', value: si(toRpm(s.effort(W)), 'rpm') },
      { label: 'Gravity torque', value: si(grav.flows[0], 'N·m') },
    ],
  }));
}

export function torqueSource(b: ModelBuilder, id: string, name: string, shaft: string, tau = -0.01) {
  const W = b.node(shaft, 'rotational');
  const pT = param({ key: 'tau', label: 'Torque', symbol: 'τ', value: tau, unit: 'N·m', source: 'cad', event: true });
  const el = new FlowSource(`${id}.tau`, W, GROUND, 'rotational', get(pT));
  return b.add(comp({
    id, name, type: 'lib://mechanical/torque-load', group: 'Rotational' as Group,
    ports: [port('shaft', 'rotational', W)], params: [pT], elements: [el] as Element[],
    summary: () => si(pT.value, 'N·m'),
    derived: (s: Simulator) => [{ label: 'Torque', value: si(pT.value, 'N·m') }, { label: 'Power', value: si(pT.value * s.effort(W), 'W') }],
  }));
}

// ================================================================ fluid (absolute pressure, mass flow)

const BAR = 1e5;
const rho = (value: number, label = 'Fluid density') => param({ key: 'rho', label, symbol: 'ρ', value, unit: 'kg/m³', source: 'handbook', min: 0.01 });

/** Gas-pressurized tank held at a set pressure by its regulator. */
export function pressureTank(b: ModelBuilder, id: string, name: string, out: string, bar = 22) {
  const O = b.node(out, 'fluid');
  const pP = param({ key: 'p', label: 'Regulated pressure (absolute)', symbol: 'p', value: bar * BAR, unit: 'bar', scale: BAR, source: 'datasheet', min: 0, event: true });
  const pOn = param({ key: 'on', label: 'Pressurized (1) or vented (0)', symbol: 'on', value: 1, unit: '', source: 'cad', event: true });
  const el = new EffortSource(`${id}.p`, O, GROUND, 'fluid', () => (pOn.value >= 0.5 ? pP.value : 1.01325e5));
  return b.add(comp({
    id, name, type: 'lib://fluid/pressurized-tank', group: 'Fluid' as Group,
    ports: [port('out', 'fluid', O)], params: [pP, pOn], elements: [el] as Element[],
    outflow: () => -el.flows[0],
    summary: () => si(-el.flows[0], 'kg/s'),
    derived: (s: Simulator) => [{ label: 'Pressure', value: si(s.effort(O) / BAR, 'bar') }, { label: 'Outflow', value: si(-el.flows[0], 'kg/s') }],
  }));
}

/** Open vessel at atmospheric pressure: the return end of a hydraulic loop. */
export function atmosphere(b: ModelBuilder, id: string, name: string, node: string) {
  const N = b.node(node, 'fluid');
  const el = new EffortSource(`${id}.atm`, N, GROUND, 'fluid', () => 1.01325e5);
  return b.add(comp({
    id, name, type: 'lib://fluid/reservoir', group: 'Fluid' as Group,
    ports: [port('port', 'fluid', N)], params: [], elements: [el] as Element[],
    summary: () => '1.013 bar',
    derived: () => [{ label: 'Net inflow', value: si(el.flows[0], 'kg/s') }],
  }));
}

/** Valve with a timed open/close schedule and a linear opening ramp. */
export function valve(b: ModelBuilder, id: string, name: string, a: string, z: string, opts: { cdA?: number; rho?: number; open?: number; close?: number; ramp?: number } = {}) {
  const A = b.node(a, 'fluid'), Z = b.node(z, 'fluid');
  const pA = param({ key: 'cdA', label: 'Flow area × Cd, fully open', symbol: 'Cd·A', value: opts.cdA ?? 40e-6, unit: 'mm²', scale: 1e-6, source: 'datasheet', min: 0 });
  const pR = rho(opts.rho ?? 1000);
  const pO = param({ key: 'open', label: 'Opens at', symbol: 't_open', value: opts.open ?? 0.5, unit: 's', source: 'cad', min: 0 });
  const pC = param({ key: 'close', label: 'Closes at', symbol: 't_close', value: opts.close ?? 1e6, unit: 's', source: 'cad', min: 0 });
  const pT = param({ key: 'ramp', label: 'Stroke time', symbol: 't_s', value: opts.ramp ?? 0.08, unit: 's', source: 'datasheet', min: 1e-4 });
  const manual = { override: -1 };
  const opening = (t: number) => {
    if (manual.override >= 0) return manual.override;
    const up = Math.min(1, Math.max(0, (t - pO.value) / pT.value));
    const down = Math.min(1, Math.max(0, (t - pC.value) / pT.value));
    return Math.max(0, up - down);
  };
  let now = 0;
  const el = new SqrtFlow(`${id}.v`, A, Z, (t) => { now = t; return pA.value * Math.sqrt(2 * pR.value) * opening(t); });
  return b.add(comp({
    id, name, type: 'lib://fluid/valve', group: 'Fluid' as Group,
    ports: [port('in', 'fluid', A), port('out', 'fluid', Z)], params: [pA, pR, pO, pC, pT], elements: [el] as Element[],
    opening: () => opening(now),
    flow: () => el.flows[0],
    summary: () => `${Math.round(opening(now) * 100)} % open`,
    derived: (s: Simulator) => [{ label: 'Opening', value: si(opening(now) * 100, '%') }, { label: 'Mass flow', value: si(el.flows[0], 'kg/s') }, { label: 'Pressure drop', value: si(s.effort(A) - s.effort(Z), 'Pa') }],
    actions: [{ label: 'Open / close now', run: (s: Simulator) => { manual.override = opening(now) > 0.5 ? 0 : 1; s.markEvent(); } }, { label: 'Back to schedule', run: (s: Simulator) => { manual.override = -1; s.markEvent(); } }],
  }));
}

/** Pipe with Darcy friction and fluid inertance (Δp = f·L/D·ṁ²/(2ρA²) + (L/A)·dṁ/dt). */
export function feedLine(b: ModelBuilder, id: string, name: string, a: string, z: string, opts: { L?: number; D?: number; f?: number; rho?: number } = {}) {
  const A = b.node(a, 'fluid'), Z = b.node(z, 'fluid'), M = b.node(`${id}.mid`, 'fluid');
  const pL = param({ key: 'L', label: 'Length', symbol: 'L', value: opts.L ?? 1.5, unit: 'm', source: 'cad', min: 1e-3 });
  const pD = param({ key: 'D', label: 'Inner diameter', symbol: 'D', value: opts.D ?? 0.012, unit: 'mm', scale: 1e-3, source: 'cad', min: 1e-4 });
  const pF = param({ key: 'f', label: 'Darcy friction factor', symbol: 'f', value: opts.f ?? 0.03, unit: '', source: 'handbook', min: 1e-4 });
  const pR = rho(opts.rho ?? 1000);
  const area = () => (Math.PI * pD.value * pD.value) / 4;
  const fr = new SqrtFlow(`${id}.f`, A, M, () => area() * Math.sqrt((2 * pR.value * pD.value) / (pF.value * pL.value)));
  const ind = new Inductance(`${id}.L`, M, Z, 'fluid', () => pL.value / area());
  return b.add(comp({
    id, name, type: 'lib://fluid/pipe', group: 'Fluid' as Group,
    ports: [port('in', 'fluid', A), port('out', 'fluid', Z)], params: [pL, pD, pF, pR], elements: [fr, ind] as Element[],
    flow: () => ind.i,
    summary: () => si(ind.i, 'kg/s'),
    derived: (s: Simulator) => {
      const v = ind.i / (pR.value * area());
      return [
        { label: 'Mass flow', value: si(ind.i, 'kg/s') },
        { label: 'Velocity', value: si(v, 'm/s') },
        { label: 'Pressure drop', value: si(s.effort(A) - s.effort(Z), 'Pa') },
        { label: 'Reynolds number (water)', value: si((pR.value * Math.abs(v) * pD.value) / 1e-3, '') },
      ];
    },
  }));
}

export function orifice(b: ModelBuilder, id: string, name: string, a: string, z: string, cdA = 10e-6, density = 1000) {
  const A = b.node(a, 'fluid'), Z = b.node(z, 'fluid');
  const pA = param({ key: 'cdA', label: 'Discharge coefficient × area', symbol: 'Cd·A', value: cdA, unit: 'mm²', scale: 1e-6, source: 'sysid', min: 0 });
  const pR = rho(density);
  const el = new SqrtFlow(`${id}.o`, A, Z, () => pA.value * Math.sqrt(2 * pR.value));
  return b.add(comp({
    id, name, type: 'lib://fluid/orifice', group: 'Fluid' as Group,
    ports: [port('in', 'fluid', A), port('out', 'fluid', Z)], params: [pA, pR], elements: [el] as Element[],
    summary: () => si(el.flows[0], 'kg/s'),
    derived: (s: Simulator) => [{ label: 'Mass flow', value: si(el.flows[0], 'kg/s') }, { label: 'Pressure drop', value: si(s.effort(A) - s.effort(Z), 'Pa') }],
  }));
}

/** Positive-displacement pump: ṁ = ρ·D·ω·ηv, torque = D·Δp, with internal slip leakage. */
export function pdPump(b: ModelBuilder, id: string, name: string, ports: { shaft: string; inlet: string; outlet: string }) {
  const W = b.node(ports.shaft, 'rotational'), I = b.node(ports.inlet, 'fluid'), O = b.node(ports.outlet, 'fluid');
  const pD = param({ key: 'D', label: 'Displacement', symbol: 'D', value: 1.6e-6, unit: 'cm³/rad', scale: 1e-6, source: 'datasheet', min: 1e-12 });
  const pR = rho(1000);
  const pS = param({ key: 'slip', label: 'Slip conductance', symbol: 'Gₛ', value: 2e-9, unit: 'kg/(s·Pa)', source: 'sysid', min: 0 });
  const g = new Gyrator(`${id}.pump`, W, GROUND, O, I, 'rotational', 'fluid', get(pD), () => pR.value * pD.value);
  const slip = new Conductance(`${id}.slip`, O, I, 'fluid', get(pS));
  const fric = new Conductance(`${id}.fric`, W, GROUND, 'rotational', () => 2e-5);
  return b.add(comp({
    id, name, type: 'lib://fluid/pd-pump', group: 'Couplings' as Group,
    ports: [port('shaft', 'rotational', W), port('inlet', 'fluid', I), port('outlet', 'fluid', O)], params: [pD, pR, pS], elements: [g, slip, fric] as Element[],
    delivered: () => -g.flows[2] - slip.flows[0],
    summary: () => si(-g.flows[2] - slip.flows[0], 'kg/s'),
    derived: (s: Simulator) => {
      const dp = s.effort(O) - s.effort(I);
      const q = -g.flows[2] - slip.flows[0];
      const shaft = g.flows[0] * s.effort(W) + fric.flows[0] * s.effort(W);
      const hyd = (dp * q) / pR.value;
      return [
        { label: 'Delivered flow', value: si(q, 'kg/s') },
        { label: 'Pressure rise', value: si(dp, 'Pa') },
        { label: 'Hydraulic power', value: si(hyd, 'W') },
        { label: 'Overall efficiency', value: shaft > 1e-6 ? si((100 * hyd) / shaft, '%') : '—' },
      ];
    },
  }));
}

/** Single-acting hydraulic cylinder: F = A·Δp, ṁ = ρ·A·v. */
export function hydraulicCylinder(b: ModelBuilder, id: string, name: string, ports: { cap: string; ret: string; rod: string }) {
  const C = b.node(ports.cap, 'fluid'), R = b.node(ports.ret, 'fluid'), V = b.node(ports.rod, 'translational');
  const pA = param({ key: 'A', label: 'Bore area', symbol: 'A', value: 1.2e-3, unit: 'cm²', scale: 1e-4, source: 'datasheet', min: 1e-8 });
  const pR = rho(870, 'Oil density');
  const g = new Gyrator(`${id}.cyl`, C, R, V, GROUND, 'fluid', 'translational', () => pR.value * pA.value, get(pA));
  return b.add(comp({
    id, name, type: 'lib://fluid/hydraulic-cylinder', group: 'Couplings' as Group,
    ports: [port('cap', 'fluid', C), port('return', 'fluid', R), port('rod', 'translational', V)], params: [pA, pR], elements: [g] as Element[],
    summary: () => si(-g.flows[2], 'N'),
    derived: (s: Simulator) => [{ label: 'Rod force', value: si(-g.flows[2], 'N') }, { label: 'Rod speed', value: si(s.effort(V), 'm/s') }],
  }));
}

/**
 * Liquid bipropellant thrust chamber with injectors, choked de Laval nozzle and a regeneratively
 * cooled wall. Defaults describe a ~2 kN LOX/ethanol engine at about 15 bar chamber pressure.
 */
export function thrustChamber(b: ModelBuilder, id: string, name: string, ports: { ox: string; fuel: string; wall: string }) {
  const OX = b.node(ports.ox, 'fluid'), FU = b.node(ports.fuel, 'fluid'), WALL = b.node(ports.wall, 'thermal');
  const CH = b.node(`${id}.chamber`, 'fluid');
  const P: Param[] = [
    param({ key: 'cdaOx', label: 'Oxidizer injector Cd·A', symbol: 'CdA_ox', value: 13.8e-6, unit: 'mm²', scale: 1e-6, source: 'sysid', min: 1e-9 }),
    param({ key: 'cdaFu', label: 'Fuel injector Cd·A', symbol: 'CdA_f', value: 12.8e-6, unit: 'mm²', scale: 1e-6, source: 'sysid', min: 1e-9 }),
    param({ key: 'rhoOx', label: 'Oxidizer density (LOX)', symbol: 'ρ_ox', value: 1141, unit: 'kg/m³', source: 'handbook', min: 1 }),
    param({ key: 'rhoFu', label: 'Fuel density (ethanol)', symbol: 'ρ_f', value: 789, unit: 'kg/m³', source: 'handbook', min: 1 }),
    param({ key: 'Dt', label: 'Throat diameter', symbol: 'D_t', value: 0.0348, unit: 'mm', scale: 1e-3, source: 'cad', min: 1e-4 }),
    param({ key: 'eps', label: 'Nozzle expansion ratio', symbol: 'ε', value: 4, unit: '', source: 'cad', min: 1.01 }),
    param({ key: 'V', label: 'Chamber volume', symbol: 'V_c', value: 9.5e-4, unit: 'L', scale: 1e-3, source: 'cad', min: 1e-6 }),
    param({ key: 'cstar', label: 'Peak c* (theoretical)', symbol: 'c*max', value: 1720, unit: 'm/s', source: 'handbook', min: 100 }),
    param({ key: 'mrOpt', label: 'Mixture ratio at peak c*', symbol: 'O/F*', value: 1.4, unit: '', source: 'handbook', min: 0.1 }),
    param({ key: 'eta', label: 'c* efficiency', symbol: 'η_c*', value: 0.95, unit: '', source: 'prior', min: 0.1 }),
    param({ key: 'tau', label: 'Combustion time lag', symbol: 'τ_c', value: 0.002, unit: 'ms', scale: 1e-3, source: 'prior', min: 0 }),
    param({ key: 'tIgn', label: 'Igniter fires at', symbol: 't_ign', value: 0.55, unit: 's', source: 'cad', min: 0 }),
    param({ key: 'hRef', label: 'Gas-side h at 15 bar', symbol: 'h_g', value: 2000, unit: 'W/(m²·K)', source: 'prior', min: 0 }),
    param({ key: 'Aw', label: 'Hot-gas wall area', symbol: 'A_w', value: 0.02, unit: 'm²', source: 'cad', min: 1e-5 }),
  ];
  const v = (k: string) => () => P.find((x) => x.key === k)!.value;
  const el = new ThrustChamber(`${id}.tca`, OX, FU, CH, WALL, {
    Kox: () => v('cdaOx')() * Math.sqrt(2 * v('rhoOx')()),
    Kfu: () => v('cdaFu')() * Math.sqrt(2 * v('rhoFu')()),
    At: () => (Math.PI * v('Dt')() ** 2) / 4,
    eps: v('eps'), V: v('V'), gamma: 1.2, cstarMax: v('cstar'), mrOpt: v('mrOpt'), etaC: v('eta'), tau: v('tau'),
    tIgnite: v('tIgn'), hRef: v('hRef'), pcRef: () => 15e5, wallArea: v('Aw'), ambient: () => 1.01325e5,
  });
  const s = el.state;
  return b.add(comp({
    id, name, type: 'lib://propulsion/thrust-chamber-biprop', group: 'Couplings' as Group,
    ports: [port('ox', 'fluid', OX), port('fuel', 'fluid', FU), port('wall', 'thermal', WALL)], params: P, elements: [el] as Element[],
    state: s,
    summary: () => (s.burning ? si(s.thrust, 'N') : 'not burning'),
    derived: () => [
      { label: 'Thrust', value: si(s.thrust, 'N') },
      { label: 'Chamber pressure', value: si(s.pc / BAR, 'bar') },
      { label: 'Mixture ratio O/F', value: s.mr > 0 ? s.mr.toFixed(2) : '—' },
      { label: 'Oxidizer / fuel flow', value: `${s.mdotOx.toFixed(3)} / ${s.mdotFu.toFixed(3)} kg/s` },
      { label: 'c*', value: si(s.cstar, 'm/s') },
      { label: 'Thrust coefficient Cf', value: s.cf.toFixed(3) },
      { label: 'Specific impulse', value: si(s.isp, 's') },
      { label: 'Heat to wall', value: si(s.heat, 'W') },
      { label: 'Total impulse', value: si(s.impulse, 'N·s') },
    ],
  }));
}

// ================================================================ thermal

export function heatSource(b: ModelBuilder, id: string, name: string, node: string, watts = 10) {
  const T = b.node(node, 'thermal');
  const pP = param({ key: 'P', label: 'Heat input', symbol: 'Q̇', value: watts, unit: 'W', source: 'datasheet', event: true });
  const el = new FlowSource(`${id}.Q`, T, GROUND, 'thermal', get(pP));
  return b.add(comp({
    id, name, type: 'lib://thermal/heat-source', group: 'Thermal' as Group,
    ports: [port('node', 'thermal', T)], params: [pP], elements: [el] as Element[],
    summary: () => si(pP.value, 'W'),
    derived: (s: Simulator) => [{ label: 'Heat input', value: si(pP.value, 'W') }, { label: 'Temperature', value: si(toCelsius(s.effort(T)), '°C') }],
  }));
}

/**
 * Fluid volume (manifold, accumulator, line compliance): stores mass as pressure rises,
 * dm/dt = (V / a²)·dp/dt, where a is the effective speed of sound (lower with entrained gas).
 */
export function fluidVolume(b: ModelBuilder, id: string, name: string, node: string, opts: { V?: number; a?: number } = {}) {
  const N = b.node(node, 'fluid');
  const pV = param({ key: 'V', label: 'Volume', symbol: 'V', value: opts.V ?? 1e-4, unit: 'L', scale: 1e-3, source: 'cad', min: 1e-9 });
  const pA = param({ key: 'a', label: 'Effective speed of sound', symbol: 'a', value: opts.a ?? 300, unit: 'm/s', source: 'prior', min: 1 });
  const el = new Capacitance(`${id}.C`, N, GROUND, 'fluid', () => pV.value / (pA.value * pA.value));
  return b.add(comp({
    id, name, type: 'lib://fluid/volume', group: 'Fluid' as Group,
    ports: [port('port', 'fluid', N)], params: [pV, pA], elements: [el] as Element[],
    summary: (s: Simulator) => si(s.effort(N) / BAR, 'bar'),
    derived: (s: Simulator) => [{ label: 'Pressure', value: si(s.effort(N) / BAR, 'bar') }, { label: 'Net inflow', value: si(el.flows[0], 'kg/s') }],
  }));
}
