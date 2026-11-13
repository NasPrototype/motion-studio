/**
 * Lab & Reference library: design blueprints, laboratory test procedures and foundational
 * experiments across engineering branches. Content lives in src/lab/data/*.ts as LabEntry arrays.
 */

export type EntryKind = 'blueprint' | 'procedure' | 'experiment';

export type Branch =
  | 'aerospace' | 'agricultural' | 'architectural' | 'biomedical' | 'chemical' | 'civil' | 'computer'
  | 'data' | 'design' | 'electrical' | 'electronics' | 'energy' | 'environmental' | 'industrial'
  | 'manufacturing' | 'marine' | 'materials' | 'mechanical' | 'mechatronics' | 'mining' | 'nuclear'
  | 'petroleum' | 'process' | 'robotics' | 'software' | 'structural' | 'systems';

/** Teaching laboratories and workshops; see facilities.ts. */
export type LabId =
  | 'workshop' | 'engg-drawing' | 'machine-drawing' | 'applied-mechanics' | 'fluid-mechanics'
  | 'material-testing' | 'thermo-heat-transfer' | 'design-practice' | 'metrology' | 'machining'
  | 'ic-engine' | 'dynamics-of-machines' | 'ac-refrigeration' | 'design-practice-2'
  | 'adv-manufacturing' | 'thermal-power';

export interface Equation {
  /** What the equation gives, e.g. "Engineering stress". */
  label: string;
  /** Plain Unicode, no TeX, e.g. "σ = F / A₀". */
  text: string;
}

export interface LabEntry {
  /** Unique kebab-case id, prefixed with the primary branch, e.g. "mechanical-morse-test". */
  id: string;
  kind: EntryKind;
  title: string;
  /** First entry is the primary branch. */
  branches: Branch[];
  labs?: LabId[];
  /** One or two sentences: what it is and why engineers use it. */
  summary: string;
  /** For procedures and experiments: the question the test answers. */
  objective?: string;
  /** Instruments, machines, materials or software. */
  equipment: string[];
  /**
   * Procedures and experiments: 4–8 imperative steps in order.
   * Blueprints: 4–8 design steps or the contents of the drawing set, in order.
   */
  steps: string[];
  /** What is measured, or the governing design parameters, with units. */
  measurements: string[];
  equations?: Equation[];
  /** Real standards only, e.g. "ASTM E8/E8M", "ISO 6892-1", "ACI 318". */
  standards?: string[];
  safety?: string[];
  /** Deliverables: plots, tables, drawings, reports. */
  outputs?: string[];
  /** Id of a Studio example or virtual test bench that demonstrates this entry (see SIM_TARGETS). */
  sim?: string;
  tags?: string[];
}

/** Studio examples and virtual test benches that entries may link to with `sim`. */
export const SIM_TARGETS = {
  // examples (scenes)
  'motor-flywheel': 'DC motor driving a geared flywheel with winding heating',
  'led-blinker': 'NE555 astable LED blinker on a breadboard',
  'torsion-pendulum': 'Torsion pendulum, free oscillation and integrator damping',
  'quarter-car': 'Quarter-car suspension over a road bump',
  'spring-mass-damper': 'Spring–mass–damper free vibration (log decrement)',
  'robot-joint': 'Robot joint servo: PID position control of a geared motor and link',
  'robot-arm': '3-axis robot arm doing a pick-and-place cycle',
  'rocket-engine': 'Pressure-fed LOX/ethanol rocket engine on a test stand',
  'pump-loop': 'Hydraulic lift: motor-driven gear pump, valve, cylinder and load',
  // virtual test benches
  'bench-tensile': 'Tensile test on a universal testing machine (yield, UTS, elongation)',
  'bench-charpy': 'Charpy V-notch impact test and ductile–brittle transition',
  'bench-fatigue': 'Fatigue S–N curve (Basquin) with Goodman mean-stress correction',
  'bench-hardness': 'Brinell hardness from indentation diameter',
  'bench-torsion': 'Torsion test: shear modulus from twist',
  'bench-spring': 'Helical spring stiffness test',
  'bench-morse': 'Morse test on a multi-cylinder engine (indicated power, mechanical efficiency)',
  'bench-pipe-friction': 'Turbulent pipe-loop pressure drop and Darcy friction factor',
  'bench-venturi': 'Venturimeter discharge coefficient',
  'bench-reynolds': "Reynolds' experiment: laminar, transitional and turbulent flow",
  'bench-heat-exchanger': 'Shell-and-tube heat exchanger: LMTD, effectiveness, U',
  'bench-hotfire': 'Static hot-fire test of the rocket engine example',
  'bench-wind-tunnel': 'Wind tunnel drag and lift coefficients',
  'bench-concrete': 'Concrete cylinder compression (f′c) with ACI acceptance',
  'bench-shake-table': 'Shake table test of a 3-story shear-frame model',
  'bench-bomb-calorimeter': 'Bomb calorimetry: gross calorific value',
  'bench-gc-retention': 'Gas chromatography: Kovats retention index',
  'bench-bioreactor-kla': 'Bioreactor kLa by dynamic gassing-out and dissolved-oxygen validation',
  'bench-fft': 'Oscilloscope FFT: noise floor, THD and SNR of a sampled signal',
  'bench-emc': 'EMC radiated-emission pre-scan against CISPR 32 limits at 3 m',
} as const;

export type SimTarget = keyof typeof SIM_TARGETS;
