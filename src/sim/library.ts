import type { Domain, Simulator } from './core';
import {
  ambient, battery, capacitor, damper, dcMotor, flywheel, gearbox, groundPart, heatMass, inductor, led,
  type Component, type Group, type ModelBuilder, resistor, switchPart, thermalResistance, timer555, torsionSpring,
} from './components';
import type { Drive, LabelLine, Trace, Vec3, VisualKind } from './scenes';
import { LIBRARY_EXT } from './library-ext';
import { si, toCelsius, toRpm } from './units';

export interface PortDef {
  name: string;
  domain: Domain;
  /** Position in the part's own frame, before scale and rotation. */
  at: Vec3;
}

export interface Built {
  component: Component;
  drive?: (sim: Simulator) => Drive;
  label?: (sim: Simulator) => LabelLine[];
  /** Strips this part offers when it is placed in an editable project. */
  traces?: Trace[];
}

export interface PartType {
  type: string;
  name: string;
  prefix: string;
  group: Group | 'Reference';
  blurb: string;
  ports: PortDef[];
  /** Parameter keys and what they mean, for the photo service's prompt. */
  paramHints: string;
  visual: VisualKind;
  elevation: number;
  scale: number;
  footprint: number;
  /** Height of the callout above the floor, when the default guess is wrong for the model. */
  labelTop?: number;
  visualOpts?: Record<string, string | number | boolean>;
  build(b: ModelBuilder, id: string, nodes: Record<string, string>): Built;
}

const AMBIENT_K = 295.15;

export const LIBRARY: PartType[] = [
  {
    type: 'battery', name: 'Battery', prefix: 'B', group: 'Electrical', blurb: 'Voltage source with internal resistance.',
    ports: [{ name: 'p', domain: 'electrical', at: [-1.2, 3.9, 0] }, { name: 'n', domain: 'electrical', at: [1.2, 3.9, 0] }],
    paramHints: 'E = open-circuit voltage in V; R = internal resistance in ohm',
    visual: 'battery', elevation: 0, scale: 1, footprint: 3.6, visualOpts: { label: 'DC' },
    build(b, id, n) {
      const c = battery(b, id, 'Battery', n.p, n.n);
      return { component: c, label: (s) => [{ text: si(s.effort(c.ports[0].node) - s.effort(c.ports[1].node), 'V'), domain: 'electrical' }, { text: si(c.current(), 'A'), domain: 'electrical' }] };
    },
  },
  {
    type: 'switch', name: 'Switch', prefix: 'S', group: 'Electrical', blurb: 'Toggle switch. Toggle it from the inspector.',
    ports: [{ name: 'a', domain: 'electrical', at: [-1.1, 0.95, 0] }, { name: 'b', domain: 'electrical', at: [1.1, 0.95, 0] }],
    paramHints: 'Ron = contact resistance in ohm',
    visual: 'switch', elevation: 0, scale: 1, footprint: 2.2,
    build(b, id, n) {
      const c = switchPart(b, id, 'Switch', n.a, n.b, true);
      return { component: c, drive: () => ({ closed: c.state.closed }), label: () => [{ text: c.state.closed ? 'closed' : 'open' }] };
    },
  },
  {
    type: 'resistor', name: 'Resistor', prefix: 'R', group: 'Electrical', blurb: 'Linear resistor.',
    ports: [{ name: 'a', domain: 'electrical', at: [-1.1, -0.35, 0] }, { name: 'b', domain: 'electrical', at: [1.1, -0.35, 0] }],
    paramHints: 'R = resistance in ohm (read the color bands)',
    visual: 'resistor', elevation: 1.15, scale: 1, footprint: 1.8,
    build(b, id, n) {
      const c = resistor(b, id, 'Resistor', n.a, n.b, 1e3);
      return { component: c, label: () => [{ text: si(c.current(), 'A'), domain: 'electrical' }] };
    },
  },
  {
    type: 'capacitor', name: 'Capacitor', prefix: 'C', group: 'Electrical', blurb: 'Linear capacitor.',
    ports: [{ name: 'a', domain: 'electrical', at: [-0.35, 0.2, 0.7] }, { name: 'b', domain: 'electrical', at: [0.35, 0.2, 0.7] }],
    paramHints: 'C = capacitance in F (e.g. 4.7e-5 for 47 uF). Port a is + on electrolytics',
    visual: 'electrolytic', elevation: 0, scale: 1, footprint: 1.6,
    build(b, id, n) {
      const c = capacitor(b, id, 'Capacitor', n.a, n.b, 47e-6);
      return { component: c, drive: (s) => ({ charge: c.voltage(s) / 9 }), label: (s) => [{ text: si(c.voltage(s), 'V'), domain: 'electrical' }] };
    },
  },
  {
    type: 'inductor', name: 'Inductor', prefix: 'L', group: 'Electrical', blurb: 'Linear inductor.',
    ports: [{ name: 'a', domain: 'electrical', at: [-1.4, -0.5, 0] }, { name: 'b', domain: 'electrical', at: [1.4, -0.5, 0] }],
    paramHints: 'L = inductance in H',
    visual: 'inductor', elevation: 0.9, scale: 1, footprint: 2,
    build(b, id, n) {
      const c = inductor(b, id, 'Inductor', n.a, n.b, 10e-3);
      return { component: c, label: () => [{ text: si(c.current(), 'A'), domain: 'electrical' }] };
    },
  },
  {
    type: 'led', name: 'LED', prefix: 'D', group: 'Electrical', blurb: 'Red 5 mm LED (Shockley diode).',
    ports: [{ name: 'anode', domain: 'electrical', at: [-0.65, 0.15, 0] }, { name: 'cathode', domain: 'electrical', at: [0.65, 0.15, 0] }],
    paramHints: 'Rs = series resistance in ohm (rarely needed)',
    visual: 'led', elevation: 0, scale: 1, footprint: 1.6,
    build(b, id, n) {
      const c = led(b, id, 'LED', n.anode, n.cathode);
      return { component: c, drive: () => ({ current: c.current() }), label: () => [{ text: si(c.current(), 'A'), domain: 'electrical' }] };
    },
  },
  {
    type: 'timer555', name: 'NE555 timer', prefix: 'U', group: 'Electrical', blurb: 'Behavioral 555 with internal divider and push-pull output.',
    ports: [
      { name: 'vcc', domain: 'electrical', at: [-0.75, 0.1, -1.0] }, { name: 'dis', domain: 'electrical', at: [-0.25, 0.1, -1.0] },
      { name: 'thr', domain: 'electrical', at: [0.25, 0.1, -1.0] }, { name: 'ctrl', domain: 'electrical', at: [0.75, 0.1, -1.0] },
      { name: 'gnd', domain: 'electrical', at: [-0.75, 0.1, 1.0] }, { name: 'trig', domain: 'electrical', at: [-0.25, 0.1, 1.0] },
      { name: 'out', domain: 'electrical', at: [0.25, 0.1, 1.0] },
    ],
    paramHints: 'no parameters; pins: vcc (8), dis (7), thr (6), ctrl (5), gnd (1), trig (2), out (3). Reset (4) is assumed tied to vcc',
    visual: 'dip8', elevation: 0, scale: 2, footprint: 3, visualOpts: { label: 'NE555' },
    build(b, id, n) {
      const c = timer555(b, id, 'NE555 timer', { vcc: n.vcc, gnd: n.gnd, trig: n.trig, thr: n.thr, dis: n.dis, out: n.out, ctrl: n.ctrl });
      return {
        component: c,
        drive: () => ({ high: c.state.q }),
        label: () => [{ text: c.state.q ? 'output high' : 'output low', domain: 'electrical' }, { text: c.state.period > 0 ? si(1 / c.state.period, 'Hz') : 'measuring' }],
      };
    },
  },
  {
    type: 'ground', name: 'Ground', prefix: 'GND', group: 'Reference', blurb: 'Electrical 0 V reference. Every circuit needs one.',
    ports: [{ name: 'g', domain: 'electrical', at: [0, 0.9, 0] }],
    paramHints: 'no parameters',
    visual: 'ground', elevation: 0, scale: 1, footprint: 1.2,
    build(b, id) { return { component: groundPart(b, id, 'Ground') }; },
  },
  {
    type: 'dcmotor', name: 'DC motor', prefix: 'M', group: 'Couplings', blurb: 'Brushed PM motor: winding, back-EMF, rotor, self-heating.',
    ports: [
      { name: 'p', domain: 'electrical', at: [-2.4, 0.7, 0.7] }, { name: 'n', domain: 'electrical', at: [-2.4, -0.7, -0.7] },
      { name: 'shaft', domain: 'rotational', at: [5, 0, 0] }, { name: 'heat', domain: 'thermal', at: [0, 1.75, 0] },
    ],
    paramHints: 'R = winding resistance in ohm; k = torque constant in N*m/A; L = inductance in H; J = rotor inertia in kg*m^2; b = rotor friction in N*m*s; alpha = copper temperature coefficient in 1/K',
    visual: 'motor', elevation: 6, scale: 1, footprint: 4.2,
    build(b, id, n) {
      const c = dcMotor(b, id, 'DC motor', { p: n.p, n: n.n, shaft: n.shaft, heat: n.heat });
      return {
        component: c,
        drive: (s) => ({ omega: c.omega(s), heat: c.temperature(s) - AMBIENT_K }),
        label: (s) => [
          { text: si(c.current(), 'A'), domain: 'electrical' },
          { text: si(toCelsius(c.temperature(s)), '°C'), domain: 'thermal' },
          { text: si(toRpm(c.omega(s)), 'rpm'), domain: 'rotational' },
        ],
      };
    },
  },
  {
    type: 'gearbox', name: 'Gearbox', prefix: 'G', group: 'Rotational', blurb: 'Ideal reduction: output turns n times slower with n times the torque.',
    ports: [{ name: 'in', domain: 'rotational', at: [-2.4, 0, 0] }, { name: 'out', domain: 'rotational', at: [2.4, 0, 0] }],
    paramHints: 'n = reduction ratio (input speed / output speed)',
    visual: 'gearbox', elevation: 6, scale: 1, footprint: 3,
    build(b, id, n) {
      const c = gearbox(b, id, 'Gearbox', n.in, n.out, 3);
      return { component: c, drive: (s) => ({ win: s.effort(c.ports[0].node), wout: s.effort(c.ports[1].node) }) };
    },
  },
  {
    type: 'flywheel', name: 'Flywheel', prefix: 'F', group: 'Rotational', blurb: 'Rotational inertia.',
    ports: [{ name: 'shaft', domain: 'rotational', at: [-1.6, 0, 0] }],
    paramHints: 'J = moment of inertia in kg*m^2',
    visual: 'flywheel', elevation: 6, scale: 1, footprint: 5, visualOpts: { radius: 4.5, stand: true },
    build(b, id, n) {
      const c = flywheel(b, id, 'Flywheel', n.shaft, 2.4e-4);
      return { component: c, drive: (s) => ({ omega: c.omega(s) }), label: (s) => [{ text: si(toRpm(c.omega(s)), 'rpm'), domain: 'rotational' }] };
    },
  },
  {
    type: 'damper', name: 'Bearing drag', prefix: 'BR', group: 'Rotational', blurb: 'Viscous drag to the frame.',
    ports: [{ name: 'shaft', domain: 'rotational', at: [0, 6, 0] }],
    paramHints: 'b = viscous drag in N*m*s',
    visual: 'bearing', elevation: 0, scale: 1, footprint: 2, visualOpts: { height: 6 },
    build(b, id, n) { return { component: damper(b, id, 'Bearing drag', n.shaft, 4e-4) }; },
  },
  {
    type: 'spring', name: 'Torsion spring', prefix: 'K', group: 'Rotational', blurb: 'Torsional spring to the frame.',
    ports: [{ name: 'shaft', domain: 'rotational', at: [-2.2, 0, 0] }],
    paramHints: 'k = stiffness in N*m/rad; theta0 = initial twist in rad',
    visual: 'coilspring', elevation: 6, scale: 1, footprint: 3,
    build(b, id, n) {
      const c = torsionSpring(b, id, 'Torsion spring', n.shaft, 0.2, 0);
      return { component: c, drive: () => ({ twist: c.angle() }) };
    },
  },
  {
    type: 'heatmass', name: 'Heat mass', prefix: 'W', group: 'Thermal', blurb: 'Heat capacity.',
    ports: [{ name: 'node', domain: 'thermal', at: [0, 1.8, 0] }],
    paramHints: 'C = heat capacity in J/K',
    visual: 'heatblock', elevation: 0, scale: 1, footprint: 2,
    build(b, id, n) {
      const c = heatMass(b, id, 'Heat mass', n.node, 4.2);
      const node = c.ports[0].node;
      return { component: c, drive: (s) => ({ heat: s.effort(node) - AMBIENT_K }), label: (s) => [{ text: si(toCelsius(s.effort(node)), '°C'), domain: 'thermal' }] };
    },
  },
  {
    type: 'thermalres', name: 'Thermal resistance', prefix: 'RT', group: 'Thermal', blurb: 'Conduction or convection path.',
    ports: [{ name: 'a', domain: 'thermal', at: [-1.2, 0.35, 0] }, { name: 'b', domain: 'thermal', at: [1.2, 0.35, 0] }],
    paramHints: 'Rth = thermal resistance in K/W',
    visual: 'thermalpad', elevation: 0, scale: 1, footprint: 2,
    build(b, id, n) { return { component: thermalResistance(b, id, 'Thermal resistance', n.a, n.b, 18) }; },
  },
  {
    type: 'ambient', name: 'Ambient air', prefix: 'A', group: 'Thermal', blurb: 'Fixed air temperature that absorbs heat.',
    ports: [{ name: 'node', domain: 'thermal', at: [0, 0.3, 0.6] }],
    paramHints: 'T = air temperature in K (295.15 K = 22 C)',
    visual: 'ambient', elevation: 0, scale: 1, footprint: 1.6,
    build(b, id, n) {
      const c = ambient(b, id, 'Ambient air', n.node, 22);
      return { component: c, label: () => [{ text: si(toCelsius(c.params[0].value), '°C'), domain: 'thermal' }] };
    },
  },
  ...LIBRARY_EXT,
];

export const PART_TYPES = new Map(LIBRARY.map((t) => [t.type, t]));

/** World position of a port for a part placed at (x, z) and turned by `rot` radians about +Y. */
export function portWorld(t: PartType, pos: [number, number], rot: number, port: string): Vec3 {
  const def = t.ports.find((p) => p.name === port);
  const [lx, ly, lz] = def ? def.at : [0, 0, 0];
  const s = t.scale;
  const c = Math.cos(rot), sn = Math.sin(rot);
  const x = lx * s, z = lz * s;
  return [pos[0] + x * c + z * sn, t.elevation + ly * s, pos[1] - x * sn + z * c];
}
