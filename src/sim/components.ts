import { type Domain, type Element, type NodeInfo, GROUND, Simulator } from './core';
import {
  Capacitance, Conductance, Diode, EffortSource, HeatingResistor, Inductance, Logic, TwoPort,
} from './elements';
import { si, toCelsius, toRpm } from './units';

export type Evidence = 'sysid' | 'datasheet' | 'cad' | 'handbook' | 'prior';

export interface Param {
  key: string;
  label: string;
  symbol: string;
  /** SI value. */
  value: number;
  /** Display unit; displayed = value / scale − offset. */
  unit: string;
  scale: number;
  offset: number;
  sigma?: number;
  source: Evidence;
  min?: number;
  /** Editing it is a discontinuity, so the next step restarts with implicit Euler. */
  event?: boolean;
}

export interface Port {
  name: string;
  domain: Domain;
  node: number;
}

export interface Readout {
  label: string;
  value: string;
}

export type Group = 'Electrical' | 'Couplings' | 'Rotational' | 'Translational' | 'Fluid' | 'Thermal' | 'Control';

export interface Component {
  id: string;
  name: string;
  type: string;
  group: Group;
  ports: Port[];
  params: Param[];
  elements: Element[];
  summary(sim: Simulator): string;
  derived?(sim: Simulator): Readout[];
  actions?: { label: string; run(sim: Simulator): void }[];
}

type ParamInit = Omit<Param, 'scale' | 'offset'> & { scale?: number; offset?: number };
export const param = (p: ParamInit): Param => ({ scale: 1, offset: 0, ...p });
export const get = (p: Param) => () => p.value;

/** Collects nodes and components into one flat network for the simulator. */
export class ModelBuilder {
  readonly nodes: NodeInfo[] = [];
  readonly components: Component[] = [];
  private readonly ids = new Map<string, number>();

  node(id: string, domain: Domain): number {
    if (id === 'gnd') return GROUND;
    const existing = this.ids.get(id);
    if (existing !== undefined) {
      if (this.nodes[existing].domain !== domain) throw new Error(`Node ${id} joined across domains`);
      return existing;
    }
    const index = this.nodes.length;
    this.nodes.push({ id, domain, index });
    this.ids.set(id, index);
    return index;
  }

  add<T extends Component>(c: T): T {
    this.components.push(c);
    return c;
  }

  /**
   * All elements, plus a tiny leakage from every node to its reference so an open switch, an
   * unconnected port or a free gearbox never leaves a node undetermined.
   */
  elements(): Element[] {
    const els = this.components.flatMap((c) => c.elements);
    for (const nd of this.nodes) els.push(new Conductance(`gmin.${nd.id}`, nd.index, GROUND, nd.domain, () => 1e-12));
    return els;
  }
}

/** Flow into the component at one of its ports (positive = into the component). */
export function portFlow(c: Component, port: Port): number {
  let f = 0;
  for (const el of c.elements) {
    el.terminals.forEach((node, k) => { if (node === port.node) f += el.flows[k]; });
  }
  return f;
}

export function portEffortText(sim: Simulator, port: Port): string {
  const e = sim.effort(port.node);
  if (port.domain === 'thermal') return si(toCelsius(e), '°C');
  if (port.domain === 'rotational') return si(e, 'rad/s');
  if (port.domain === 'translational') return si(e, 'm/s');
  if (port.domain === 'fluid') return si(e, 'Pa');
  return si(e, 'V');
}

export function portFlowText(c: Component, port: Port): string {
  const f = portFlow(c, port);
  if (port.domain === 'thermal') return si(f, 'W');
  if (port.domain === 'rotational') return si(f, 'N·m');
  if (port.domain === 'translational') return si(f, 'N');
  if (port.domain === 'fluid') return si(f, 'kg/s');
  return si(f, 'A');
}

// ---------------------------------------------------------------- electrical

export function battery(b: ModelBuilder, id: string, name: string, p: string, n: string, emf = 6, rint = 0.2) {
  const P = b.node(p, 'electrical');
  const N = b.node(n, 'electrical');
  const I = b.node(`${id}.emf`, 'electrical');
  const pE = param({ key: 'E', label: 'Open-circuit voltage', symbol: 'E', value: emf, unit: 'V', sigma: 0.05 * emf, source: 'datasheet', min: 0, event: true });
  const pR = param({ key: 'R', label: 'Internal resistance', symbol: 'Rᵢ', value: rint, unit: 'Ω', sigma: 0.3 * rint, source: 'prior', min: 1e-4 });
  const src = new EffortSource(`${id}.E`, I, N, 'electrical', get(pE));
  const res = new Conductance(`${id}.Rint`, I, P, 'electrical', () => 1 / pR.value);
  const c: Component & { current(): number } = {
    id, name, type: 'lib://sources/battery', group: 'Electrical',
    ports: [{ name: 'p', domain: 'electrical', node: P }, { name: 'n', domain: 'electrical', node: N }],
    params: [pE, pR],
    elements: [src, res],
    current: () => res.flows[0],
    summary: (sim) => si(sim.effort(P) - sim.effort(N), 'V'),
    derived: (sim) => [
      { label: 'Terminal voltage', value: si(sim.effort(P) - sim.effort(N), 'V') },
      { label: 'Current delivered', value: si(res.flows[0], 'A') },
      { label: 'Power delivered', value: si((sim.effort(P) - sim.effort(N)) * res.flows[0], 'W') },
    ],
  };
  return b.add(c);
}

export function switchPart(b: ModelBuilder, id: string, name: string, a: string, z: string, closed = true) {
  const A = b.node(a, 'electrical');
  const Z = b.node(z, 'electrical');
  const state = { closed };
  const pR = param({ key: 'Ron', label: 'Contact resistance', symbol: 'Rₒₙ', value: 0.01, unit: 'Ω', source: 'datasheet', min: 1e-5 });
  const el = new Conductance(`${id}.contact`, A, Z, 'electrical', () => (state.closed ? 1 / pR.value : 1e-9));
  const c: Component & { state: typeof state } = {
    id, name, type: 'lib://switches/spst-toggle', group: 'Electrical',
    ports: [{ name: 'a', domain: 'electrical', node: A }, { name: 'b', domain: 'electrical', node: Z }],
    params: [pR],
    elements: [el],
    state,
    summary: () => (state.closed ? 'closed' : 'open'),
    derived: () => [{ label: 'Current', value: si(el.flows[0], 'A') }],
    actions: [{ label: 'Toggle switch', run: (sim) => { state.closed = !state.closed; sim.markEvent(); } }],
  };
  return b.add(c);
}

export function resistor(b: ModelBuilder, id: string, name: string, a: string, z: string, R: number, source: Evidence = 'datasheet') {
  const A = b.node(a, 'electrical');
  const Z = b.node(z, 'electrical');
  const pR = param({ key: 'R', label: 'Resistance', symbol: 'R', value: R, unit: 'Ω', sigma: 0.05 * R, source, min: 1e-6 });
  const el = new Conductance(`${id}.R`, A, Z, 'electrical', () => 1 / pR.value);
  return b.add<Component & { current(): number }>({
    id, name, type: 'lib://passives/resistor', group: 'Electrical',
    ports: [{ name: 'a', domain: 'electrical', node: A }, { name: 'b', domain: 'electrical', node: Z }],
    params: [pR], elements: [el],
    current: () => el.flows[0],
    summary: () => si(pR.value, 'Ω'),
    derived: (sim) => [
      { label: 'Voltage across', value: si(sim.effort(A) - sim.effort(Z), 'V') },
      { label: 'Current', value: si(el.flows[0], 'A') },
      { label: 'Power', value: si(el.flows[0] * (sim.effort(A) - sim.effort(Z)), 'W') },
    ],
  });
}

export function capacitor(b: ModelBuilder, id: string, name: string, a: string, z: string, C: number, source: Evidence = 'datasheet') {
  const A = b.node(a, 'electrical');
  const Z = b.node(z, 'electrical');
  const pC = param({ key: 'C', label: 'Capacitance', symbol: 'C', value: C, unit: 'F', sigma: 0.2 * C, source, min: 1e-15 });
  const el = new Capacitance(`${id}.C`, A, Z, 'electrical', get(pC));
  return b.add<Component & { voltage(sim: Simulator): number }>({
    id, name, type: 'lib://passives/capacitor', group: 'Electrical',
    ports: [{ name: 'a', domain: 'electrical', node: A }, { name: 'b', domain: 'electrical', node: Z }],
    params: [pC], elements: [el],
    voltage: (sim) => sim.effort(A) - sim.effort(Z),
    summary: (sim) => si(sim.effort(A) - sim.effort(Z), 'V'),
    derived: (sim) => [
      { label: 'Voltage', value: si(sim.effort(A) - sim.effort(Z), 'V') },
      { label: 'Current', value: si(el.flows[0], 'A') },
      { label: 'Stored energy', value: si(el.stored((n) => sim.effort(n)), 'J') },
    ],
  });
}

export function led(b: ModelBuilder, id: string, name: string, anode: string, cathode: string) {
  const A = b.node(anode, 'electrical');
  const K = b.node(cathode, 'electrical');
  const M = b.node(`${id}.j`, 'electrical');
  const pRs = param({ key: 'Rs', label: 'Series resistance', symbol: 'Rₛ', value: 5, unit: 'Ω', source: 'prior', min: 1e-3 });
  const d = new Diode(`${id}.junction`, A, M, 2.2e-18, 2);
  const rs = new Conductance(`${id}.Rs`, M, K, 'electrical', () => 1 / pRs.value);
  return b.add<Component & { current(): number }>({
    id, name, type: 'lib://optoelectronics/led-5mm-red', group: 'Electrical',
    ports: [{ name: 'anode', domain: 'electrical', node: A }, { name: 'cathode', domain: 'electrical', node: K }],
    params: [pRs], elements: [d, rs],
    current: () => d.flows[0],
    summary: () => si(d.flows[0], 'A'),
    derived: (sim) => [
      { label: 'Forward voltage', value: si(sim.effort(A) - sim.effort(K), 'V') },
      { label: 'Current', value: si(d.flows[0], 'A') },
      { label: 'Brightness', value: si(Math.min(100, (Math.max(0, d.flows[0]) / 0.02) * 100), '%') },
    ],
  });
}

/**
 * Behavioral NE555: internal 5 kΩ divider, set/reset comparators, a push-pull output that draws
 * its current from VCC, and the discharge transistor. Thresholds follow the control pin.
 */
export function timer555(b: ModelBuilder, id: string, name: string, pins: { vcc: string; gnd: string; trig: string; thr: string; dis: string; out: string; ctrl: string }) {
  const V = b.node(pins.vcc, 'electrical');
  const G = b.node(pins.gnd, 'electrical');
  const TR = b.node(pins.trig, 'electrical');
  const TH = b.node(pins.thr, 'electrical');
  const D = b.node(pins.dis, 'electrical');
  const O = b.node(pins.out, 'electrical');
  const C = b.node(pins.ctrl, 'electrical');
  const L = b.node(`${id}.third`, 'electrical');
  const s = { q: false, lastRise: -1, period: 0 };
  const off = 1e-9;
  const els: Element[] = [
    new Conductance(`${id}.div1`, V, C, 'electrical', () => 1 / 5000),
    new Conductance(`${id}.div2`, C, L, 'electrical', () => 1 / 5000),
    new Conductance(`${id}.div3`, L, G, 'electrical', () => 1 / 5000),
    new Conductance(`${id}.supply`, V, G, 'electrical', () => 1 / 3000),
    new Conductance(`${id}.outHigh`, V, O, 'electrical', () => (s.q ? 1 / 70 : off)),
    new Conductance(`${id}.outLow`, O, G, 'electrical', () => (s.q ? off : 1 / 10)),
    new Conductance(`${id}.discharge`, D, G, 'electrical', () => (s.q ? off : 1 / 20)),
    new Logic(`${id}.flipflop`, (e, t) => {
      let q = s.q;
      if (e(TR) < e(L)) q = true;
      else if (e(TH) > e(C)) q = false;
      if (q === s.q) return false;
      if (q) {
        if (s.lastRise >= 0) s.period = t - s.lastRise;
        s.lastRise = t;
      }
      s.q = q;
      return true;
    }, () => { s.q = false; s.lastRise = -1; s.period = 0; }),
  ];
  return b.add<Component & { state: typeof s }>({
    id, name, type: 'lib://ics/ne555-behavioral', group: 'Electrical',
    ports: [
      { name: 'vcc', domain: 'electrical', node: V }, { name: 'gnd', domain: 'electrical', node: G },
      { name: 'trig', domain: 'electrical', node: TR }, { name: 'thr', domain: 'electrical', node: TH },
      { name: 'dis', domain: 'electrical', node: D }, { name: 'out', domain: 'electrical', node: O },
      { name: 'ctrl', domain: 'electrical', node: C },
    ],
    params: [], elements: els, state: s,
    summary: () => (s.q ? 'output high' : 'output low'),
    derived: (sim) => [
      { label: 'Output', value: si(sim.effort(O) - sim.effort(G), 'V') },
      { label: 'Upper threshold', value: si(sim.effort(C) - sim.effort(G), 'V') },
      { label: 'Lower threshold', value: si(sim.effort(L) - sim.effort(G), 'V') },
      { label: 'Measured frequency', value: s.period > 0 ? si(1 / s.period, 'Hz') : 'waiting for 2 cycles' },
    ],
  });
}

export function inductor(b: ModelBuilder, id: string, name: string, a: string, z: string, L: number) {
  const A = b.node(a, 'electrical');
  const Z = b.node(z, 'electrical');
  const pL = param({ key: 'L', label: 'Inductance', symbol: 'L', value: L, unit: 'mH', scale: 1e-3, sigma: 0.1 * L, source: 'datasheet', min: 1e-9 });
  const el = new Inductance(`${id}.L`, A, Z, 'electrical', get(pL));
  return b.add<Component & { current(): number }>({
    id, name, type: 'lib://passives/inductor', group: 'Electrical',
    ports: [{ name: 'a', domain: 'electrical', node: A }, { name: 'b', domain: 'electrical', node: Z }],
    params: [pL], elements: [el],
    current: () => el.i,
    summary: () => si(el.i, 'A'),
    derived: (sim) => [
      { label: 'Current', value: si(el.i, 'A') },
      { label: 'Voltage across', value: si(sim.effort(A) - sim.effort(Z), 'V') },
      { label: 'Stored energy', value: si(el.stored(), 'J') },
    ],
  });
}

/** Electrical reference. Its net is the solver's ground node. */
export function groundPart(b: ModelBuilder, id: string, name: string) {
  return b.add<Component>({
    id, name, type: 'lib://reference/ground', group: 'Electrical',
    ports: [{ name: 'g', domain: 'electrical', node: GROUND }],
    params: [], elements: [],
    summary: () => '0 V',
  });
}

// ---------------------------------------------------------------- couplings

export function dcMotor(b: ModelBuilder, id: string, name: string, ports: { p: string; n: string; shaft: string; heat: string }) {
  const P = b.node(ports.p, 'electrical');
  const N = b.node(ports.n, 'electrical');
  const S = b.node(ports.shaft, 'rotational');
  const H = b.node(ports.heat, 'thermal');
  const R1 = b.node(`${id}.r`, 'electrical');
  const R2 = b.node(`${id}.l`, 'electrical');
  const T0 = 295.15;
  const pR = param({ key: 'R', label: 'Winding resistance', symbol: 'R @ 22 °C', value: 2.4, unit: 'Ω', sigma: 0.25, source: 'datasheet', min: 1e-3 });
  const pA = param({ key: 'alpha', label: 'Copper temp. coefficient', symbol: 'α', value: 0.00393, unit: '1/K', source: 'handbook', min: 0 });
  const pL = param({ key: 'L', label: 'Inductance', symbol: 'L', value: 2.3e-3, unit: 'mH', scale: 1e-3, sigma: 4e-4, source: 'prior', min: 1e-7 });
  const pk = param({ key: 'k', label: 'Torque constant', symbol: 'k', value: 0.012, unit: 'N·m/A', sigma: 4e-4, source: 'sysid', min: 1e-6 });
  const pJ = param({ key: 'J', label: 'Rotor inertia', symbol: 'J', value: 1.2e-6, unit: 'kg·m²', sigma: 2e-7, source: 'cad', min: 1e-10 });
  const pb = param({ key: 'b', label: 'Rotor friction', symbol: 'b', value: 1e-6, unit: 'N·m·s', source: 'prior', min: 0 });
  const winding = new HeatingResistor(`${id}.winding`, P, R1, H, get(pR), get(pA), T0);
  const coupling = new TwoPort(`${id}.emf`, R2, N, S, GROUND, 'electrical', 'rotational', get(pk));
  const c = {
    id, name, type: 'lib://actuators/dc-motor/pm-brushed', group: 'Couplings' as Group,
    ports: [
      { name: 'p', domain: 'electrical' as Domain, node: P }, { name: 'n', domain: 'electrical' as Domain, node: N },
      { name: 'shaft', domain: 'rotational' as Domain, node: S }, { name: 'heat', domain: 'thermal' as Domain, node: H },
    ],
    params: [pR, pk, pL, pJ, pb, pA],
    elements: [
      winding,
      new Inductance(`${id}.L`, R1, R2, 'electrical', get(pL)),
      coupling,
      new Capacitance(`${id}.rotor`, S, GROUND, 'rotational', get(pJ)),
      new Conductance(`${id}.friction`, S, GROUND, 'rotational', get(pb)),
    ] as Element[],
    current: () => winding.flows[0],
    omega: (sim: Simulator) => sim.effort(S),
    temperature: (sim: Simulator) => sim.effort(H),
    summary: (sim: Simulator) => si(toRpm(sim.effort(S)), 'rpm'),
    derived: (sim: Simulator) => {
      const i = winding.flows[0];
      const w = sim.effort(S);
      const pin = (sim.effort(P) - sim.effort(N)) * i;
      const pout = -portFlowAt(c.elements, S) * w;
      return [
        { label: 'Resistance now', value: si(winding.resistance(sim.effort(H)), 'Ω') },
        { label: 'Back-EMF', value: si(pk.value * w, 'V') },
        { label: 'Copper loss', value: si(-winding.flows[2], 'W') },
        { label: 'Shaft power', value: si(pout, 'W') },
        { label: 'Efficiency', value: pin > 1e-6 ? si((100 * pout) / pin, '%') : '—' },
        { label: 'Speed', value: si(toRpm(w), 'rpm') },
      ];
    },
  };
  return b.add(c);
}

function portFlowAt(els: Element[], node: number): number {
  let f = 0;
  for (const el of els) el.terminals.forEach((n, k) => { if (n === node) f += el.flows[k]; });
  return f;
}

export function gearbox(b: ModelBuilder, id: string, name: string, input: string, output: string, ratio = 3) {
  const I = b.node(input, 'rotational');
  const O = b.node(output, 'rotational');
  const pN = param({ key: 'n', label: 'Ratio', symbol: 'n', value: ratio, unit: '', source: 'cad', min: 0.01, event: true });
  const el = new TwoPort(`${id}.mesh`, I, GROUND, O, GROUND, 'rotational', 'rotational', get(pN));
  return b.add<Component>({
    id, name, type: 'lib://transmissions/spur-pair', group: 'Rotational',
    ports: [{ name: 'in', domain: 'rotational', node: I }, { name: 'out', domain: 'rotational', node: O }],
    params: [pN], elements: [el],
    summary: () => `${+pN.value.toFixed(2)} : 1`,
    derived: (sim) => [
      { label: 'Input speed', value: si(toRpm(sim.effort(I)), 'rpm') },
      { label: 'Output speed', value: si(toRpm(sim.effort(O)), 'rpm') },
      { label: 'Input torque', value: si(el.flows[0], 'N·m') },
      { label: 'Output torque', value: si(-el.flows[2], 'N·m') },
    ],
  });
}

// ---------------------------------------------------------------- rotational

export function flywheel(b: ModelBuilder, id: string, name: string, shaft: string, J: number) {
  const S = b.node(shaft, 'rotational');
  const pJ = param({ key: 'J', label: 'Moment of inertia', symbol: 'J', value: J, unit: 'kg·m²', sigma: 0.02 * J, source: 'cad', min: 1e-9 });
  const el = new Capacitance(`${id}.J`, S, GROUND, 'rotational', get(pJ));
  return b.add<Component & { omega(sim: Simulator): number }>({
    id, name, type: 'lib://mechanical/flywheel', group: 'Rotational',
    ports: [{ name: 'shaft', domain: 'rotational', node: S }],
    params: [pJ], elements: [el],
    omega: (sim) => sim.effort(S),
    summary: (sim) => si(toRpm(sim.effort(S)), 'rpm'),
    derived: (sim) => [
      { label: 'Speed', value: si(toRpm(sim.effort(S)), 'rpm') },
      { label: 'Kinetic energy', value: si(el.stored((n) => sim.effort(n)), 'J') },
    ],
  });
}

export function damper(b: ModelBuilder, id: string, name: string, shaft: string, bv: number) {
  const S = b.node(shaft, 'rotational');
  const pb = param({ key: 'b', label: 'Viscous drag', symbol: 'b', value: bv, unit: 'N·m·s', sigma: 0.2 * bv, source: 'prior', min: 0 });
  const el = new Conductance(`${id}.b`, S, GROUND, 'rotational', get(pb));
  return b.add<Component>({
    id, name, type: 'lib://mechanical/bearing-drag', group: 'Rotational',
    ports: [{ name: 'shaft', domain: 'rotational', node: S }],
    params: [pb], elements: [el],
    summary: (sim) => si(el.flows[0] * sim.effort(S), 'W'),
    derived: (sim) => [
      { label: 'Drag torque', value: si(el.flows[0], 'N·m') },
      { label: 'Power lost', value: si(el.flows[0] * sim.effort(S), 'W') },
    ],
  });
}

export function torsionSpring(b: ModelBuilder, id: string, name: string, shaft: string, k: number, theta0: number) {
  const S = b.node(shaft, 'rotational');
  const pk = param({ key: 'k', label: 'Torsional stiffness', symbol: 'k', value: k, unit: 'N·m/rad', sigma: 0.05 * k, source: 'sysid', min: 1e-6 });
  const pT = param({ key: 'theta0', label: 'Initial twist', symbol: 'θ₀', value: theta0, unit: '°', scale: Math.PI / 180, source: 'cad' });
  const el = new Inductance(`${id}.k`, S, GROUND, 'rotational', () => 1 / pk.value, () => pk.value * pT.value);
  return b.add<Component & { angle(): number }>({
    id, name, type: 'lib://mechanical/torsion-spring', group: 'Rotational',
    ports: [{ name: 'shaft', domain: 'rotational', node: S }],
    params: [pk, pT], elements: [el],
    angle: () => el.i / pk.value,
    summary: () => si(((el.i / pk.value) * 180) / Math.PI, '°'),
    derived: () => [
      { label: 'Twist', value: si(((el.i / pk.value) * 180) / Math.PI, '°') },
      { label: 'Spring torque', value: si(el.i, 'N·m') },
      { label: 'Stored energy', value: si(el.stored(), 'J') },
    ],
  });
}

// ---------------------------------------------------------------- thermal

export function heatMass(b: ModelBuilder, id: string, name: string, node: string, C: number) {
  const T = b.node(node, 'thermal');
  const pC = param({ key: 'C', label: 'Heat capacity', symbol: 'C', value: C, unit: 'J/K', sigma: 0.15 * C, source: 'prior', min: 1e-6 });
  return b.add<Component>({
    id, name, type: 'lib://thermal/heat-capacity', group: 'Thermal',
    ports: [{ name: 'node', domain: 'thermal', node: T }],
    params: [pC], elements: [new Capacitance(`${id}.C`, T, GROUND, 'thermal', get(pC))],
    summary: (sim) => si(toCelsius(sim.effort(T)), '°C'),
    derived: (sim) => [{ label: 'Temperature', value: si(toCelsius(sim.effort(T)), '°C') }],
  });
}

export function thermalResistance(b: ModelBuilder, id: string, name: string, a: string, z: string, Rth: number) {
  const A = b.node(a, 'thermal');
  const Z = b.node(z, 'thermal');
  const pR = param({ key: 'Rth', label: 'Thermal resistance', symbol: 'Rₜₕ', value: Rth, unit: 'K/W', sigma: 0.2 * Rth, source: 'prior', min: 1e-4 });
  const el = new Conductance(`${id}.Rth`, A, Z, 'thermal', () => 1 / pR.value);
  return b.add<Component>({
    id, name, type: 'lib://thermal/conduction', group: 'Thermal',
    ports: [{ name: 'a', domain: 'thermal', node: A }, { name: 'b', domain: 'thermal', node: Z }],
    params: [pR], elements: [el],
    summary: () => si(pR.value, 'K/W'),
    derived: () => [{ label: 'Heat flow', value: si(el.flows[0], 'W') }],
  });
}

export function ambient(b: ModelBuilder, id: string, name: string, node: string, celsius: number) {
  const T = b.node(node, 'thermal');
  const pT = param({ key: 'T', label: 'Air temperature', symbol: 'Tₐ', value: celsius + 273.15, unit: '°C', offset: 273.15, source: 'sysid', event: true });
  const el = new EffortSource(`${id}.T`, T, GROUND, 'thermal', get(pT));
  return b.add<Component>({
    id, name, type: 'lib://thermal/ambient', group: 'Thermal',
    ports: [{ name: 'node', domain: 'thermal', node: T }],
    params: [pT], elements: [el],
    summary: () => si(toCelsius(pT.value), '°C'),
    derived: () => [{ label: 'Heat absorbed', value: si(el.flows[0], 'W') }],
  });
}
