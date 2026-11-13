import type { Domain, Element, Method, NodeInfo, Simulator } from './core';
import {
  ambient, battery, capacitor, damper, dcMotor, flywheel, gearbox, heatMass, led, ModelBuilder,
  portFlow, resistor, switchPart, thermalResistance, timer555, torsionSpring, type Component,
} from './components';
import { si, toCelsius, toRpm } from './units';
import { EXT_SCENES } from './scenes-ext';

export type Vec3 = [number, number, number];

export type VisualKind =
  | 'battery' | 'switch' | 'motor' | 'gearpair' | 'flywheel' | 'bearing' | 'ambient'
  | 'breadboard' | 'dip8' | 'resistor' | 'electrolytic' | 'ceramic' | 'led' | 'battery9v' | 'torsionRig'
  | 'ground' | 'inductor' | 'gearbox' | 'coilspring' | 'heatblock' | 'thermalpad'
  | 'device' | 'diode' | 'powerres' | 'mass' | 'linspring' | 'lindamper' | 'force' | 'road' | 'anchor'
  | 'rackpinion' | 'link' | 'tank' | 'reservoir' | 'valve' | 'pipe' | 'orifice' | 'pump' | 'hydcylinder'
  | 'thrustchamber' | 'teststand' | 'smdRig' | 'quarterCar' | 'robotArm';

export type Drive = Record<string, number | boolean>;

export interface VisualItem {
  kind: VisualKind;
  component?: string;
  pos: Vec3;
  opts?: Record<string, number | string | boolean | undefined>;
  drive?: (sim: Simulator) => Drive;
}

export interface WireSpec {
  /** Set for editable wires so the editor can select and delete them. */
  id?: string;
  domain: Domain;
  points: Vec3[];
  /** Flow along the wire in the direction of `points`; drives the moving dots. */
  flow?: (sim: Simulator) => number;
  /** Flow that reads as "busy" (dots near full speed). */
  scale?: number;
}

export interface LabelLine {
  text: string;
  domain?: Domain;
}

export interface LabelSpec {
  component: string;
  anchor: Vec3;
  lines: (sim: Simulator) => LabelLine[];
}

export interface Trace {
  label: string;
  unit: string;
  domain: Domain;
  get: (sim: Simulator) => number;
  /** Fixed lower bound for the strip; the upper bound follows the data. */
  min?: number;
  /** Channel name from a connected device to overlay on this strip. */
  hwKey?: string;
}

export interface SceneInstance {
  nodes: NodeInfo[];
  elements: Element[];
  components: Component[];
  traces: Trace[];
  initial: (nodeId: string) => number | undefined;
  camera: { pos: Vec3; target: Vec3 };
  items: VisualItem[];
  wires: WireSpec[];
  labels: LabelSpec[];
}

export interface SceneDef {
  id: string;
  name: string;
  summary: string;
  tip?: string;
  h: number;
  method: Method;
  defaultSelection: string;
  create(): SceneInstance;
}

/** A gentle arc between two points, lifted by `lift` at the middle. */
function arc(a: Vec3, b: Vec3, lift: number, n = 6): Vec3[] {
  const pts: Vec3[] = [];
  for (let i = 0; i <= n; i++) {
    const s = i / n;
    pts.push([a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s + Math.sin(Math.PI * s) * lift, a[2] + (b[2] - a[2]) * s]);
  }
  return pts;
}

const roomTemperature = (nodeId: string) => (nodeId.startsWith('th.') ? 295.15 : undefined);

// ------------------------------------------------------------------------------------------

const motorFlywheel: SceneDef = {
  id: 'motor-flywheel',
  name: 'Motor + flywheel',
  summary: 'A 6 V battery drives a DC motor through a switch. A 3 : 1 spur pair spins a flywheel against bearing drag, and the winding heats toward ambient.',
  tip: 'Toggle S1 to stop the motor and watch the flywheel coast down. Raise the bearing drag and watch the winding temperature climb.',
  h: 5e-4,
  method: 'be',
  defaultSelection: 'M1',
  create() {
    const b = new ModelBuilder();
    const B1 = battery(b, 'B1', 'Battery', 'b.p', 'gnd', 6, 0.2);
    const S1 = switchPart(b, 'S1', 'Switch', 'b.p', 'm.p', true);
    const M1 = dcMotor(b, 'M1', 'DC motor', { p: 'm.p', n: 'gnd', shaft: 'shaft.m', heat: 'th.w' });
    const G1 = gearbox(b, 'G1', 'Gearbox', 'shaft.m', 'shaft.f', 3);
    const F1 = flywheel(b, 'F1', 'Flywheel', 'shaft.f', 2.4e-4);
    damper(b, 'D1', 'Bearing drag', 'shaft.f', 4e-4);
    heatMass(b, 'W1', 'Winding mass', 'th.w', 4.2);
    const R1 = thermalResistance(b, 'R1', 'Case to air', 'th.w', 'th.a', 18);
    const A1 = ambient(b, 'A1', 'Ambient', 'th.a', 22);
    const ratio = () => G1.params[0].value;
    const ambientK = () => A1.params[0].value;
    const heatOut = () => R1.elements[0].flows[0];

    return {
      nodes: b.nodes,
      elements: b.elements(),
      components: b.components,
      initial: roomTemperature,
      traces: [
        { label: 'Motor current', unit: 'A', domain: 'electrical', get: () => M1.current(), min: 0 },
        { label: 'Flywheel speed', unit: 'rpm', domain: 'rotational', get: (s) => toRpm(F1.omega(s)), min: 0, hwKey: 'rpm' },
        { label: 'Winding temperature', unit: '°C', domain: 'thermal', get: (s) => toCelsius(M1.temperature(s)) },
      ],
      camera: { pos: [19, 18, 32], target: [-2, 5, 1] },
      items: [
        { kind: 'battery', component: 'B1', pos: [-15, 0, -3], opts: { label: '6 V' } },
        { kind: 'switch', component: 'S1', pos: [-10, 0, 4], drive: () => ({ closed: S1.state.closed }) },
        {
          kind: 'motor', component: 'M1', pos: [-4, 6, 0],
          drive: (s) => ({ omega: M1.omega(s), heat: M1.temperature(s) - ambientK() }),
        },
        { kind: 'gearpair', component: 'G1', pos: [0, 6, 0], opts: { follows: 'M1' }, drive: () => ({ ratio: ratio() }) },
        { kind: 'bearing', component: 'D1', pos: [5, 0, 4.8], opts: { height: 6 } },
        { kind: 'flywheel', component: 'F1', pos: [9, 6, 4.8], opts: { follows: 'M1', radius: 4.5 }, drive: () => ({ ratio: ratio() }) },
        { kind: 'ambient', component: 'A1', pos: [-4, 10.6, -2.5] },
      ],
      wires: [
        { domain: 'electrical', points: [[-16.2, 3.75, -3], [-16.4, 1.2, -1.2], [-15, 0.15, 2], [-12.5, 0.15, 4], [-11.1, 0.75, 4]], flow: () => B1.current(), scale: 0.6 },
        { domain: 'electrical', points: [[-8.9, 0.75, 4], [-7.8, 0.15, 3.2], [-6.9, 2.5, 1.6], [-6.35, 6.7, 0.7]], flow: () => M1.current(), scale: 0.6 },
        { domain: 'electrical', points: [[-6.35, 5.3, -0.7], [-6.9, 2.2, -1.6], [-8.2, 0.15, -2.2], [-12, 0.15, -1.2], [-13.8, 1.4, -2.2], [-13.8, 3.75, -3]], flow: () => M1.current(), scale: 0.6 },
        { domain: 'thermal', points: [[-4, 7.7, 0], [-4, 9.0, -1.2], [-4, 10.4, -2.4]], flow: heatOut, scale: 1 },
      ],
      labels: [
        { component: 'B1', anchor: [-15, 5.2, -3], lines: (s) => [{ text: si(s.effort(B1.ports[0].node), 'V'), domain: 'electrical' }, { text: si(B1.current(), 'A'), domain: 'electrical' }] },
        { component: 'S1', anchor: [-10, 2.4, 4], lines: () => [{ text: S1.state.closed ? 'closed' : 'open' }] },
        {
          component: 'M1', anchor: [-4, 9.2, 0], lines: (s) => [
            { text: si(M1.current(), 'A'), domain: 'electrical' },
            { text: si(toCelsius(M1.temperature(s)), '°C'), domain: 'thermal' },
            { text: si(toRpm(M1.omega(s)), 'rpm'), domain: 'rotational' },
          ],
        },
        {
          component: 'F1', anchor: [9, 11.6, 4.8], lines: (s) => [
            { text: si(toRpm(F1.omega(s)), 'rpm'), domain: 'rotational' },
            { text: si(F1.elements[0].stored((n) => s.effort(n)), 'J'), domain: 'rotational' },
          ],
        },
        { component: 'A1', anchor: [-4, 13.0, -2.5], lines: () => [{ text: si(toCelsius(ambientK()), '°C'), domain: 'thermal' }] },
      ],
    };
  },
};

// ------------------------------------------------------------------------------------------

const ledBlinker: SceneDef = {
  id: 'led-blinker',
  name: 'LED blinker (555)',
  summary: 'An NE555 in astable mode charges C1 through R1 + R2 and discharges it through R2, blinking D1. The breadboard from the photo-to-twin review.',
  tip: 'Change R2 or C1 in the inspector. The 555 reports its measured frequency; the formula predicts 1.44 / ((R1 + 2·R2)·C1).',
  h: 5e-4,
  method: 'be',
  defaultSelection: 'U1',
  create() {
    const b = new ModelBuilder();
    const B1 = battery(b, 'B1', '9 V battery', 'vcc', 'gnd', 9, 0.5);
    const U1 = timer555(b, 'U1', 'NE555 timer', { vcc: 'vcc', gnd: 'gnd', trig: 'cap', thr: 'cap', dis: 'dis', out: 'out', ctrl: 'ctrl' });
    const R1 = resistor(b, 'R1', 'Resistor R1', 'vcc', 'dis', 1e3);
    const R2 = resistor(b, 'R2', 'Resistor R2', 'dis', 'cap', 10e3, 'prior');
    const C1 = capacitor(b, 'C1', 'Capacitor C1', 'cap', 'gnd', 47e-6, 'prior');
    const C2 = capacitor(b, 'C2', 'Capacitor C2', 'ctrl', 'gnd', 10e-9);
    const R3 = resistor(b, 'R3', 'Resistor R3', 'out', 'led', 220);
    const D1 = led(b, 'D1', 'Red LED', 'led', 'gnd');
    const vccPort = U1.ports[0];
    const outNode = U1.ports[5].node;
    const pin = (x: number, z: number): Vec3 => [x, 0.95, z];

    return {
      nodes: b.nodes,
      elements: b.elements(),
      components: b.components,
      initial: () => undefined,
      traces: [
        { label: 'Capacitor voltage', unit: 'V', domain: 'electrical', get: (s) => C1.voltage(s), min: 0, hwKey: 'vc' },
        { label: 'Timer output', unit: 'V', domain: 'electrical', get: (s) => s.effort(outNode), min: 0 },
        { label: 'LED current', unit: 'A', domain: 'electrical', get: () => D1.current(), min: 0 },
      ],
      camera: { pos: [2, 19, 17], target: [-1, 0, 0] },
      items: [
        { kind: 'breadboard', pos: [-1.5, 0, 0] },
        { kind: 'dip8', component: 'U1', pos: [0, 0.8, 0], opts: { label: 'NE555' }, drive: () => ({ high: U1.state.q }) },
        { kind: 'resistor', component: 'R1', pos: [-4, 1.15, -3], opts: { ohms: 1e3 } },
        { kind: 'resistor', component: 'R2', pos: [4, 1.15, -3], opts: { ohms: 10e3 } },
        { kind: 'resistor', component: 'R3', pos: [-4, 1.15, 3], opts: { ohms: 220 } },
        { kind: 'electrolytic', component: 'C1', pos: [7, 0.8, 0], drive: (s) => ({ charge: C1.voltage(s) / 9 }) },
        { kind: 'ceramic', component: 'C2', pos: [3, 0.8, 3] },
        { kind: 'led', component: 'D1', pos: [-8, 0.8, 3], drive: () => ({ current: D1.current() }) },
        { kind: 'battery9v', component: 'B1', pos: [-12, 0, -3] },
      ],
      wires: [
        { domain: 'electrical', points: arc([-12.5, 1.95, -4.6], [-5.1, 1.15, -3], 2.2), flow: () => B1.current(), scale: 0.03 },
        { domain: 'electrical', points: arc([-5.1, 1.15, -3], pin(-0.75, -1), 1.6), flow: () => portFlow(U1, vccPort), scale: 0.03 },
        { domain: 'electrical', points: arc([-2.9, 1.15, -3], pin(-0.25, -1), 1.0), flow: () => R1.current(), scale: 0.003 },
        { domain: 'electrical', points: arc(pin(-0.25, -1), [2.9, 1.15, -3], 1.4), flow: () => R2.current(), scale: 0.0005 },
        { domain: 'electrical', points: arc([5.1, 1.15, -3], [6.6, 0.95, -0.2], 1.0), flow: () => R2.current(), scale: 0.0005 },
        { domain: 'electrical', points: arc([6.6, 0.95, -0.2], pin(0.25, -1), 1.8) },
        { domain: 'electrical', points: arc(pin(0.25, -1), pin(-0.25, 1), 0.9) },
        { domain: 'electrical', points: arc(pin(0.75, -1), [2.8, 0.95, 3], 1.2) },
        { domain: 'electrical', points: arc(pin(0.25, 1), [-2.9, 1.15, 3], 1.2), flow: () => R3.current(), scale: 0.03 },
        { domain: 'electrical', points: arc([-5.1, 1.15, 3], [-7.75, 0.95, 3], 0.8), flow: () => D1.current(), scale: 0.03 },
        { domain: 'electrical', points: arc([-8.25, 0.95, 3], [-8.25, 0.95, 4.5], 0.4), flow: () => D1.current(), scale: 0.03 },
        { domain: 'electrical', points: arc([7.4, 0.95, 0.2], [7.4, 0.95, 4.5], 0.6), flow: () => C1.elements[0].flows[0], scale: 0.0005 },
        { domain: 'electrical', points: arc(pin(-0.75, 1), [-0.75, 0.95, 4.5], 0.6), flow: () => -portFlow(U1, U1.ports[1]), scale: 0.03 },
        { domain: 'electrical', points: arc([3.2, 0.95, 3], [3.2, 0.95, 4.5], 0.4), flow: () => C2.elements[0].flows[0], scale: 1e-5 },
        { domain: 'electrical', points: [[7.4, 0.95, 4.5], [-11.5, 0.95, 4.5], [-11.5, 1.95, -0.8], [-11.5, 1.95, -4.6]], flow: () => B1.current(), scale: 0.03 },
      ],
      labels: [
        {
          component: 'U1', anchor: [0, 2.6, 0], lines: () => [
            { text: U1.state.q ? 'output high' : 'output low', domain: 'electrical' },
            { text: U1.state.period > 0 ? si(1 / U1.state.period, 'Hz') : 'measuring' },
          ],
        },
        { component: 'C1', anchor: [7, 3.8, 0], lines: (s) => [{ text: si(C1.voltage(s), 'V'), domain: 'electrical' }] },
        { component: 'D1', anchor: [-8, 3.0, 3], lines: () => [{ text: si(D1.current(), 'A'), domain: 'electrical' }] },
        { component: 'B1', anchor: [-12, 3.4, -3], lines: (s) => [{ text: si(s.effort(vccPort.node), 'V'), domain: 'electrical' }] },
      ],
    };
  },
};

// ------------------------------------------------------------------------------------------

const torsionPendulum: SceneDef = {
  id: 'torsion-pendulum',
  name: 'Torsion pendulum',
  summary: 'A 5 g·m² disc twisted 60° on a torsion spring, released at t = 0. Energy swaps between the spring and the disc while air drag slowly takes it away.',
  tip: 'Implicit Euler drains energy from this oscillator, and the energy balance flags it. Switch the integrator to Trapezoidal and press Reset.',
  h: 5e-4,
  method: 'be',
  defaultSelection: 'K1',
  create() {
    const b = new ModelBuilder();
    const F1 = flywheel(b, 'F1', 'Inertia disc', 's', 5e-3);
    const K1 = torsionSpring(b, 'K1', 'Torsion spring', 's', 0.2, (60 * Math.PI) / 180);
    damper(b, 'D1', 'Air drag', 's', 2e-4);
    const stored = (s: Simulator) => F1.elements[0].stored((n) => s.effort(n)) + K1.elements[0].stored((n) => s.effort(n));

    return {
      nodes: b.nodes,
      elements: b.elements(),
      components: b.components,
      initial: () => undefined,
      traces: [
        { label: 'Twist angle', unit: '°', domain: 'rotational', get: () => (K1.angle() * 180) / Math.PI },
        { label: 'Disc speed', unit: 'rpm', domain: 'rotational', get: (s) => toRpm(F1.omega(s)) },
        { label: 'Stored energy', unit: 'J', domain: 'rotational', get: stored, min: 0 },
      ],
      camera: { pos: [26, 21, 38], target: [0, 10, 0] },
      items: [
        { kind: 'torsionRig', component: 'F1', pos: [0, 0, 0], opts: { spring: 'K1', damper: 'D1' }, drive: () => ({ twist: K1.angle() }) },
      ],
      wires: [],
      labels: [
        {
          component: 'F1', anchor: [6.5, 11, 0], lines: (s) => [
            { text: si((K1.angle() * 180) / Math.PI, '°'), domain: 'rotational' },
            { text: si(toRpm(F1.omega(s)), 'rpm'), domain: 'rotational' },
          ],
        },
        { component: 'K1', anchor: [2.2, 18.5, 0], lines: () => [{ text: si(K1.elements[0].stored(() => 0), 'J'), domain: 'rotational' }] },
      ],
    };
  },
};

export const SCENES: SceneDef[] = [motorFlywheel, ledBlinker, torsionPendulum, ...EXT_SCENES];
