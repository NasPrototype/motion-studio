import {
  anchor, atmosphere, currentSource, feedLine, fluidVolume, forceSource, functionGenerator, heatSource, hydraulicCylinder,
  linearDamper, linearSpring, mass, orifice, pdPump, powerResistor, pressureTank, rackPinion, rectifierDiode, roadProfile,
  robotLink, servoDrive, thrustChamber, torqueSource, valve,
} from './components-ext';
import type { PartType } from './library';
import { si, toCelsius, toRpm } from './units';

const BAR = 1e5;
const AMBIENT_K = 295.15;

/**
 * Mechanical, fluid-power, robotics and propulsion parts for the wiring editor. Port positions
 * match the 3D models in view/models-ext.ts (part frame, before scale and rotation).
 */
export const LIBRARY_EXT: PartType[] = [
  // ------------------------------------------------------------------ electrical
  {
    type: 'currentsource', name: 'Current source', prefix: 'I', group: 'Electrical', blurb: 'Ideal DC current source (drives current out of p).',
    ports: [{ name: 'p', domain: 'electrical', at: [-1, 1.75, 0] }, { name: 'n', domain: 'electrical', at: [1, 1.75, 0] }],
    paramHints: 'I = current in A',
    visual: 'device', elevation: 0, scale: 1, footprint: 3, visualOpts: { label: 'I SRC', sub: 'constant current' },
    build(b, id, n) {
      const c = currentSource(b, id, 'Current source', n.p, n.n);
      return { component: c, label: (s) => [{ text: si(c.params[0].value, 'A'), domain: 'electrical' }, { text: si(s.effort(c.ports[0].node) - s.effort(c.ports[1].node), 'V'), domain: 'electrical' }] };
    },
  },
  {
    type: 'funcgen', name: 'Function generator', prefix: 'FG', group: 'Electrical', blurb: 'Sine or square voltage with 50 Ω output.',
    ports: [{ name: 'p', domain: 'electrical', at: [-1.2, 1.95, 0] }, { name: 'n', domain: 'electrical', at: [1.2, 1.95, 0] }],
    paramHints: 'A = amplitude in V; f = frequency in Hz; offset = DC offset in V; square = 1 for a square wave, 0 for sine',
    visual: 'device', elevation: 0, scale: 1, footprint: 3.6, visualOpts: { label: 'FUNC GEN', sub: '50 Ω', w: 3.6, h: 1.8, d: 2.2, accent: '#74A6FF' },
    build(b, id, n) {
      const c = functionGenerator(b, id, 'Function generator', n.p, n.n);
      const v = (s: { effort(n: number): number }) => s.effort(c.ports[0].node) - s.effort(c.ports[1].node);
      return {
        component: c, drive: (s) => ({ level: Math.min(1, Math.abs(v(s)) / Math.max(1e-6, c.params[0].value)) }),
        label: (s) => [{ text: si(v(s), 'V'), domain: 'electrical' }],
        traces: [{ label: `${id} output`, unit: 'V', domain: 'electrical', get: (s) => v(s) }],
      };
    },
  },
  {
    type: 'rectifier', name: 'Rectifier diode', prefix: 'D', group: 'Electrical', blurb: '1N4007-class silicon rectifier.',
    ports: [{ name: 'anode', domain: 'electrical', at: [-1.1, -0.55, 0] }, { name: 'cathode', domain: 'electrical', at: [1.1, -0.55, 0] }],
    paramHints: 'no parameters; the band marks the cathode',
    visual: 'diode', elevation: 0.6, scale: 1, footprint: 1.8,
    build(b, id, n) {
      const c = rectifierDiode(b, id, 'Rectifier diode', n.anode, n.cathode);
      return { component: c, label: () => [{ text: si(c.current(), 'A'), domain: 'electrical' }] };
    },
  },
  {
    type: 'powerres', name: 'Power resistor', prefix: 'RP', group: 'Electrical', blurb: 'Wirewound resistor that heats up; its loss leaves through a heat port.',
    ports: [{ name: 'a', domain: 'electrical', at: [-1.9, 0.9, 0] }, { name: 'b', domain: 'electrical', at: [1.9, 0.9, 0] }, { name: 'heat', domain: 'thermal', at: [0, 1.45, 0] }],
    paramHints: 'R = resistance at 22 C in ohm; alpha = temperature coefficient in 1/K',
    visual: 'powerres', elevation: 0, scale: 1, footprint: 3.4,
    build(b, id, n) {
      const c = powerResistor(b, id, 'Power resistor', n.a, n.b, n.heat);
      const heat = c.ports[2].node;
      return { component: c, drive: (s) => ({ heat: s.effort(heat) - AMBIENT_K }), label: (s) => [{ text: c.summary(), domain: 'thermal' }, { text: si(toCelsius(s.effort(heat)), '°C'), domain: 'thermal' }] };
    },
  },

  // ------------------------------------------------------------------ control
  {
    type: 'servo', name: 'Servo drive (PID)', prefix: 'SD', group: 'Control', blurb: 'Digital PID position loop and H-bridge. Wire sense to the joint shaft it controls.',
    ports: [
      { name: 'p', domain: 'electrical', at: [-1.2, 1.95, 0.6] }, { name: 'n', domain: 'electrical', at: [1.2, 1.95, 0.6] },
      { name: 'sense', domain: 'rotational', at: [0, 1.95, -0.7] },
    ],
    paramHints: 'kp, ki, kd = PID gains in V/rad, V/(rad*s), V*s/rad; vmax = supply voltage in V; theta0 and target = angles in rad; tstep = step time in s',
    visual: 'device', elevation: 0, scale: 1, footprint: 3.8, visualOpts: { label: 'SERVO', sub: 'PID · H-bridge', w: 3.6, h: 1.8, d: 2.4 },
    build(b, id, n) {
      const c = servoDrive(b, id, 'Servo drive', { p: n.p, n: n.n, sense: n.sense });
      const deg = Math.PI / 180;
      return {
        component: c, drive: () => ({ level: Math.abs(c.pid.u) / Math.max(1e-6, c.params[3].value) }),
        label: () => [{ text: `${(c.pid.meas / deg).toFixed(1)}° → ${(c.pid.ref / deg).toFixed(0)}°`, domain: 'rotational' }, { text: si(c.pid.u, 'V'), domain: 'electrical' }],
        traces: [
          { label: `${id} angle`, unit: '°', domain: 'rotational', get: () => c.pid.meas / deg },
          { label: `${id} error`, unit: '°', domain: 'rotational', get: () => (c.pid.ref - c.pid.meas) / deg },
        ],
      };
    },
  },

  // ------------------------------------------------------------------ translational
  {
    type: 'mass', name: 'Mass', prefix: 'M', group: 'Translational', blurb: 'Point mass on a straight line (velocity node).',
    ports: [{ name: 'v', domain: 'translational', at: [0, 2.6, 0] }],
    paramHints: 'm = mass in kg',
    visual: 'mass', elevation: 0, scale: 1, footprint: 2.6, labelTop: 3.4,
    build(b, id, n) {
      const c = mass(b, id, 'Mass', n.v, 1);
      return {
        component: c, drive: () => ({ x: c.position() }),
        label: (s) => [{ text: si(c.position(), 'm'), domain: 'translational' }, { text: si(c.velocity(s), 'm/s'), domain: 'translational' }],
        traces: [{ label: `${id} position`, unit: 'mm', domain: 'translational', get: () => c.position() * 1000 }],
      };
    },
  },
  {
    type: 'linspring', name: 'Linear spring', prefix: 'K', group: 'Translational', blurb: 'Hookean spring between two translational nodes.',
    ports: [{ name: 'a', domain: 'translational', at: [-2.1, 0, 0] }, { name: 'b', domain: 'translational', at: [2.1, 0, 0] }],
    paramHints: 'k = stiffness in N/m; F0 = preload force in N',
    visual: 'linspring', elevation: 1.2, scale: 1, footprint: 4,
    build(b, id, n) {
      const c = linearSpring(b, id, 'Linear spring', n.a, n.b, 1000);
      return { component: c, drive: () => ({ defl: c.deflection() }), label: () => [{ text: si(c.force(), 'N'), domain: 'translational' }] };
    },
  },
  {
    type: 'lindamper', name: 'Linear damper', prefix: 'C', group: 'Translational', blurb: 'Viscous dashpot (shock absorber).',
    ports: [{ name: 'a', domain: 'translational', at: [-2.2, 0, 0] }, { name: 'b', domain: 'translational', at: [2.2, 0, 0] }],
    paramHints: 'c = damping in N*s/m',
    visual: 'lindamper', elevation: 1.2, scale: 1, footprint: 4,
    build(b, id, n) {
      const c = linearDamper(b, id, 'Linear damper', n.a, n.b, 50);
      return { component: c, label: () => [{ text: si(c.elements[0].flows[0], 'N'), domain: 'translational' }] };
    },
  },
  {
    type: 'force', name: 'Force', prefix: 'F', group: 'Translational', blurb: 'Constant force on a node: weight, a load, a push.',
    ports: [{ name: 'v', domain: 'translational', at: [0, 3.4, 0] }],
    paramHints: 'F = force in N (negative pulls down, e.g. -9.81 per kg of weight)',
    visual: 'force', elevation: 0, scale: 1, footprint: 1.2,
    build(b, id, n) {
      const c = forceSource(b, id, 'Force', n.v, -9.81);
      return { component: c, drive: () => ({ F: c.params[0].value }), label: () => [{ text: si(c.params[0].value, 'N'), domain: 'translational' }] };
    },
  },
  {
    type: 'road', name: 'Road bump', prefix: 'RD', group: 'Translational', blurb: 'Moves its node over a raised-cosine bump at a set speed.',
    ports: [{ name: 'v', domain: 'translational', at: [0, 2.1, 0] }],
    paramHints: 'h = bump height in m; L = bump length in m; speed = vehicle speed in m/s; t0 = arrival time in s',
    visual: 'road', elevation: 0, scale: 1, footprint: 6,
    build(b, id, n) {
      const c = roadProfile(b, id, 'Road bump', n.v);
      return { component: c, drive: (s) => ({ h: c.height(s) }), label: (s) => [{ text: si(c.height(s) * 1000, 'mm'), domain: 'translational' }] };
    },
  },
  {
    type: 'anchor', name: 'Fixed frame', prefix: 'FR', group: 'Reference', blurb: 'Rigid wall or bench for springs, dampers and masses. Its node never moves.',
    ports: [{ name: 'v', domain: 'translational', at: [0.8, 1.6, 0] }],
    paramHints: 'no parameters',
    visual: 'anchor', elevation: 0, scale: 1, footprint: 1.2,
    build(b, id) { return { component: anchor(b, id, 'Fixed frame') }; },
  },

  // ------------------------------------------------------------------ couplings
  {
    type: 'rackpinion', name: 'Rack and pinion', prefix: 'RP', group: 'Couplings', blurb: 'Turns shaft rotation into straight-line motion: v = R·ω.',
    ports: [{ name: 'shaft', domain: 'rotational', at: [-1.8, 0, 0] }, { name: 'rack', domain: 'translational', at: [0, -1.2, 2.6] }],
    paramHints: 'R = pinion pitch radius in m',
    visual: 'rackpinion', elevation: 2, scale: 1, footprint: 3,
    build(b, id, n) {
      const c = rackPinion(b, id, 'Rack and pinion', n.shaft, n.rack);
      let x = 0, last = 0;
      return {
        component: c,
        drive: (s) => { x += (s.t - last) * s.effort(c.ports[1].node); last = s.t; if (s.t < 1e-9) x = 0; return { omega: s.effort(c.ports[0].node), x }; },
        label: (s) => [{ text: si(s.effort(c.ports[1].node), 'm/s'), domain: 'translational' }],
      };
    },
  },
  {
    type: 'pdpump', name: 'Gear pump', prefix: 'P', group: 'Couplings', blurb: 'Positive-displacement pump: shaft speed in, mass flow out.',
    ports: [
      { name: 'shaft', domain: 'rotational', at: [-2.3, 0, 0] },
      { name: 'inlet', domain: 'fluid', at: [0.6, -0.2, 1.55] }, { name: 'outlet', domain: 'fluid', at: [0.6, -0.2, -1.55] },
    ],
    paramHints: 'D = displacement in m^3/rad; rho = fluid density in kg/m^3; slip = internal leakage in kg/(s*Pa)',
    visual: 'pump', elevation: 2, scale: 1, footprint: 3, visualOpts: { post: 0.5 },
    build(b, id, n) {
      const c = pdPump(b, id, 'Gear pump', { shaft: n.shaft, inlet: n.inlet, outlet: n.outlet });
      return {
        component: c, drive: (s) => ({ omega: s.effort(c.ports[0].node) }),
        label: (s) => [{ text: si(c.delivered(), 'kg/s'), domain: 'fluid' }, { text: si((s.effort(c.ports[2].node) - s.effort(c.ports[1].node)) / BAR, 'bar'), domain: 'fluid' }],
        traces: [{ label: `${id} pressure rise`, unit: 'bar', domain: 'fluid', get: (s) => (s.effort(c.ports[2].node) - s.effort(c.ports[1].node)) / BAR }],
      };
    },
  },
  {
    type: 'hydcylinder', name: 'Hydraulic cylinder', prefix: 'HC', group: 'Couplings', blurb: 'Oil pressure on a piston pushes the rod: F = A·Δp.',
    ports: [
      { name: 'cap', domain: 'fluid', at: [-2.2, 1.05, 0] }, { name: 'return', domain: 'fluid', at: [0.6, 1.05, 0] },
      { name: 'rod', domain: 'translational', at: [3.55, 0, 0] },
    ],
    paramHints: 'A = bore area in m^2; rho = oil density in kg/m^3',
    visual: 'hydcylinder', elevation: 1.2, scale: 1, footprint: 6,
    build(b, id, n) {
      const c = hydraulicCylinder(b, id, 'Hydraulic cylinder', { cap: n.cap, ret: n.return, rod: n.rod });
      let x = 0, last = 0;
      return {
        component: c,
        drive: (s) => { x += (s.t - last) * s.effort(c.ports[2].node); last = s.t; if (s.t < 1e-9) x = 0; return { x }; },
        label: () => [{ text: c.summary(), domain: 'translational' }],
      };
    },
  },
  {
    type: 'thrustchamber', name: 'Rocket thrust chamber', prefix: 'E', group: 'Couplings', blurb: 'Liquid bipropellant chamber with injectors, de Laval nozzle and a cooled wall.',
    ports: [
      { name: 'ox', domain: 'fluid', at: [-2.8, 0.55, 0] }, { name: 'fuel', domain: 'fluid', at: [-2.8, -0.55, 0] },
      { name: 'wall', domain: 'thermal', at: [0, 1.5, 0] },
    ],
    paramHints: 'cdaOx, cdaFu = injector Cd*A in m^2; rhoOx, rhoFu = densities; Dt = throat diameter in m; eps = expansion ratio; V = chamber volume in m^3; cstar = peak c* in m/s; mrOpt = O/F at peak; eta = c* efficiency; tau = combustion lag in s; tIgn = ignition time in s; hRef = gas-side h in W/(m^2*K); Aw = wall area in m^2',
    visual: 'thrustchamber', elevation: 2.2, scale: 1, footprint: 7, labelTop: 4.4, visualOpts: { rated: 2000 },
    build(b, id, n) {
      const c = thrustChamber(b, id, 'Thrust chamber', { ox: n.ox, fuel: n.fuel, wall: n.wall });
      const st = c.state;
      return {
        component: c, drive: (s) => ({ thrust: st.thrust, heat: s.effort(c.ports[2].node) - AMBIENT_K }),
        label: () => [{ text: si(st.thrust, 'N'), domain: 'translational' }, { text: si(st.pc / BAR, 'bar'), domain: 'fluid' }],
        traces: [
          { label: `${id} chamber pressure`, unit: 'bar', domain: 'fluid', get: () => st.pc / BAR, min: 0 },
          { label: `${id} thrust`, unit: 'N', domain: 'translational', get: () => st.thrust, min: 0 },
        ],
      };
    },
  },

  // ------------------------------------------------------------------ rotational
  {
    type: 'robotlink', name: 'Robot link', prefix: 'L', group: 'Rotational', blurb: 'Arm link on a joint: inertia plus gravity on its centre of mass.',
    ports: [{ name: 'joint', domain: 'rotational', at: [-1.5, 0, 0] }],
    paramHints: 'm = link mass in kg; l = joint to centre of mass in m; theta0 = start angle above horizontal in rad; g = 1 for gravity on, 0 for off',
    visual: 'link', elevation: 4, scale: 1, footprint: 5, labelTop: 6.5, visualOpts: { post: 3.3, length: 4 },
    build(b, id, n) {
      const c = robotLink(b, id, 'Robot link', n.joint, { m: 0.5, l: 0.15 });
      return {
        component: c, drive: () => ({ theta: c.angle() }),
        label: () => [{ text: si((c.angle() * 180) / Math.PI, '°'), domain: 'rotational' }],
        traces: [{ label: `${id} angle`, unit: '°', domain: 'rotational', get: () => (c.angle() * 180) / Math.PI }],
      };
    },
  },
  {
    type: 'torque', name: 'Torque load', prefix: 'TQ', group: 'Rotational', blurb: 'Constant torque on a shaft: a brake, a winch load, a drive.',
    ports: [{ name: 'shaft', domain: 'rotational', at: [-1.3, 0.8, 0] }],
    paramHints: 'tau = torque in N*m (negative opposes positive rotation)',
    visual: 'device', elevation: 0, scale: 1, footprint: 2.4, visualOpts: { label: 'LOAD τ', w: 2.4, h: 1.6, d: 1.8, accent: '#6DC48A' },
    build(b, id, n) {
      const c = torqueSource(b, id, 'Torque load', n.shaft);
      return { component: c, label: (s) => [{ text: si(c.params[0].value, 'N·m'), domain: 'rotational' }, { text: si(toRpm(s.effort(c.ports[0].node)), 'rpm'), domain: 'rotational' }] };
    },
  },

  // ------------------------------------------------------------------ fluid
  {
    type: 'tank', name: 'Pressurized tank', prefix: 'T', group: 'Fluid', blurb: 'Regulated gas-pressurized propellant or oil tank.',
    ports: [{ name: 'out', domain: 'fluid', at: [1.55, 0.9, 0] }],
    paramHints: 'p = regulated absolute pressure in Pa; on = 1 pressurized, 0 vented',
    visual: 'tank', elevation: 0, scale: 1, footprint: 3, labelTop: 7.2, visualOpts: { label: 'TANK', sub: 'regulated', tint: '#9FC6FF' },
    build(b, id, n) {
      const c = pressureTank(b, id, 'Pressurized tank', n.out);
      return {
        component: c, drive: (s) => ({ p: s.effort(c.ports[0].node) }),
        label: (s) => [{ text: si(s.effort(c.ports[0].node) / BAR, 'bar'), domain: 'fluid' }, { text: si(c.outflow(), 'kg/s'), domain: 'fluid' }],
        traces: [{ label: `${id} outflow`, unit: 'kg/s', domain: 'fluid', get: () => c.outflow() }],
      };
    },
  },
  {
    type: 'reservoir', name: 'Open reservoir', prefix: 'TR', group: 'Fluid', blurb: 'Vented tank at one atmosphere: the return end of a loop.',
    ports: [{ name: 'port', domain: 'fluid', at: [1.9, 0.6, 0] }],
    paramHints: 'no parameters',
    visual: 'reservoir', elevation: 0, scale: 1, footprint: 3.2,
    build(b, id, n) { return { component: atmosphere(b, id, 'Open reservoir', n.port) }; },
  },
  {
    type: 'valve', name: 'Valve', prefix: 'V', group: 'Fluid', blurb: 'Ball valve with a timed open and close. Toggle it from the inspector.',
    ports: [{ name: 'in', domain: 'fluid', at: [-1.3, 0, 0] }, { name: 'out', domain: 'fluid', at: [1.3, 0, 0] }],
    paramHints: 'cdA = discharge coefficient times area in m^2; rho = density; open, close = times in s; ramp = stroke time in s',
    visual: 'valve', elevation: 1, scale: 1, footprint: 2.6, visualOpts: { post: 0.6 },
    build(b, id, n) {
      const c = valve(b, id, 'Valve', n.in, n.out, { open: 0.2 });
      return {
        component: c, drive: () => ({ open: c.opening() }),
        label: () => [{ text: c.summary() }, { text: si(c.flow(), 'kg/s'), domain: 'fluid' }],
        traces: [{ label: `${id} flow`, unit: 'kg/s', domain: 'fluid', get: () => c.flow() }],
      };
    },
  },
  {
    type: 'pipe', name: 'Pipe', prefix: 'PL', group: 'Fluid', blurb: 'Pipe with Darcy friction and fluid inertia (water hammer).',
    ports: [{ name: 'in', domain: 'fluid', at: [-2.6, 0, 0] }, { name: 'out', domain: 'fluid', at: [2.6, 0, 0] }],
    paramHints: 'L = length in m; D = inner diameter in m; f = Darcy friction factor; rho = density in kg/m^3',
    visual: 'pipe', elevation: 1, scale: 1, footprint: 5.4,
    build(b, id, n) {
      const c = feedLine(b, id, 'Pipe', n.in, n.out);
      return { component: c, label: () => [{ text: si(c.flow(), 'kg/s'), domain: 'fluid' }] };
    },
  },
  {
    type: 'orifice', name: 'Orifice', prefix: 'OR', group: 'Fluid', blurb: 'Sharp-edged restriction: ṁ = Cd·A·√(2ρΔp).',
    ports: [{ name: 'in', domain: 'fluid', at: [-1.3, 0, 0] }, { name: 'out', domain: 'fluid', at: [1.3, 0, 0] }],
    paramHints: 'cdA = discharge coefficient times area in m^2; rho = density in kg/m^3',
    visual: 'orifice', elevation: 1, scale: 1, footprint: 2.6,
    build(b, id, n) {
      const c = orifice(b, id, 'Orifice', n.in, n.out);
      return { component: c, label: () => [{ text: c.summary(), domain: 'fluid' }] };
    },
  },
  {
    type: 'fluidvolume', name: 'Fluid volume', prefix: 'VC', group: 'Fluid', blurb: 'Manifold or accumulator compliance: stores mass as pressure rises.',
    ports: [{ name: 'port', domain: 'fluid', at: [1.55, 0.9, 0] }],
    paramHints: 'V = volume in m^3; a = effective speed of sound in m/s (lower with entrained gas)',
    visual: 'tank', elevation: 0, scale: 0.55, footprint: 1.8, labelTop: 4.2, visualOpts: { label: 'VOL', sub: 'compliance', tint: '#3CC8C8' },
    build(b, id, n) {
      const c = fluidVolume(b, id, 'Fluid volume', n.port);
      return { component: c, drive: (s) => ({ p: s.effort(c.ports[0].node) }), label: (s) => [{ text: si(s.effort(c.ports[0].node) / BAR, 'bar'), domain: 'fluid' }] };
    },
  },

  // ------------------------------------------------------------------ thermal
  {
    type: 'heatsource', name: 'Heater', prefix: 'H', group: 'Thermal', blurb: 'Fixed heat input into a thermal node.',
    ports: [{ name: 'node', domain: 'thermal', at: [0, 1.35, 0] }],
    paramHints: 'P = heat input in W',
    visual: 'device', elevation: 0, scale: 1, footprint: 2.2, visualOpts: { label: 'HEATER', w: 2, h: 1.2, d: 1.6, accent: '#FF7D69' },
    build(b, id, n) {
      const c = heatSource(b, id, 'Heater', n.node);
      return { component: c, drive: () => ({ level: c.params[0].value > 0 ? 1 : 0 }), label: (s) => [{ text: si(c.params[0].value, 'W'), domain: 'thermal' }, { text: si(toCelsius(s.effort(c.ports[0].node)), '°C'), domain: 'thermal' }] };
    },
  },
];
