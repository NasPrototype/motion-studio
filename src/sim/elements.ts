import { Element, type Domain, type StampCtx, GROUND } from './core';

type Getter = () => number;

/** Linear conductance: resistor (1/R), rotational damper (b), thermal conductance (1/Rth). */
export class Conductance extends Element {
  constructor(name: string, a: number, b: number, domain: Domain, readonly G: Getter) {
    super(name, domain === 'thermal' || domain === 'fluid' ? 'transport' : 'dissipative', [a, b], [domain, domain]);
  }
  load(c: StampCtx): void {
    const g = this.G();
    const [a, b] = this.terminals;
    const f = g * (c.e(a) - c.e(b));
    this.flow(c, 0, f);
    this.flow(c, 1, -f);
    c.addJ(a, a, g); c.addJ(a, b, -g);
    c.addJ(b, a, -g); c.addJ(b, b, g);
  }
}

/**
 * Capacitance between two nodes: electrical capacitor, rotational inertia (to ground),
 * or heat capacity (to absolute zero). Flow = C · d(Δe)/dt.
 */
export class Capacitance extends Element {
  constructor(name: string, a: number, b: number, readonly domain: Domain, readonly C: Getter) {
    super(name, 'storage', [a, b], [domain, domain]);
  }
  load(c: StampCtx): void {
    const C = this.C();
    const [a, b] = this.terminals;
    const d = c.e(a) - c.e(b);
    const d0 = c.ePrev(a) - c.ePrev(b);
    let f: number, g: number;
    if (c.method === 'trap') { g = (2 * C) / c.h; f = g * (d - d0) - this.prevFlows[0]; }
    else { g = C / c.h; f = g * (d - d0); }
    this.flow(c, 0, f);
    this.flow(c, 1, -f);
    c.addJ(a, a, g); c.addJ(a, b, -g);
    c.addJ(b, a, -g); c.addJ(b, b, g);
  }
  stored(e: (n: number) => number): number {
    const d = e(this.terminals[0]) - e(this.terminals[1]);
    if (this.domain === 'fluid') return 0;
    return this.domain === 'thermal' ? this.C() * d : 0.5 * this.C() * d * d;
  }
}

/**
 * Inductance: electrical inductor, or a torsional spring (L = 1/k) between a shaft node and ground.
 * The flow is a state: dI/dt = Δe / L.
 */
export class Inductance extends Element {
  i: number;
  private iNew: number;
  constructor(name: string, a: number, b: number, domain: Domain, readonly L: Getter, readonly i0: Getter = () => 0) {
    super(name, 'storage', [a, b], [domain, domain]);
    this.i = i0();
    this.iNew = this.i;
  }
  load(c: StampCtx): void {
    const L = this.L();
    const [a, b] = this.terminals;
    const d = c.e(a) - c.e(b);
    let g: number;
    if (c.method === 'trap') { g = c.h / (2 * L); this.iNew = this.i + g * (d + c.ePrev(a) - c.ePrev(b)); }
    else { g = c.h / L; this.iNew = this.i + g * d; }
    this.flow(c, 0, this.iNew);
    this.flow(c, 1, -this.iNew);
    c.addJ(a, a, g); c.addJ(a, b, -g);
    c.addJ(b, a, -g); c.addJ(b, b, g);
  }
  accept(): boolean { this.i = this.iNew; return false; }
  stored(): number { return this.domains[0] === 'fluid' ? 0 : 0.5 * this.L() * this.i * this.i; }
  reset(): void { this.i = this.i0(); this.iNew = this.i; }
}

/** Ideal effort source: battery EMF, ambient temperature. One branch unknown carries its flow. */
export class EffortSource extends Element {
  readonly nBranch = 1;
  constructor(name: string, a: number, b: number, domain: Domain, readonly E: (t: number) => number) {
    super(name, domain === 'thermal' ? 'reservoir' : 'source', [a, b], [domain, domain]);
  }
  load(c: StampCtx): void {
    const [a, b] = this.terminals;
    const j = c.x[this.branch];
    this.flow(c, 0, j);
    this.flow(c, 1, -j);
    c.addJ(a, this.branch, 1);
    c.addJ(b, this.branch, -1);
    c.addF(this.branch, c.e(a) - c.e(b) - this.E(c.t));
    c.addJ(this.branch, a, 1);
    c.addJ(this.branch, b, -1);
  }
}

/**
 * Ideal power-conserving two-port: Δe(a,b) = r · Δe(c,d), flow(c) = −r · flow(a).
 * A gearbox (r = ratio) and, in this effort/flow convention, a DC motor's electromechanical
 * coupling (r = k: back-EMF = k·ω, torque = k·i) are both this element.
 */
export class TwoPort extends Element {
  readonly nBranch = 1;
  constructor(name: string, a: number, b: number, c2: number, d: number, d1: Domain, d2: Domain, readonly r: Getter) {
    super(name, 'converter', [a, b, c2, d], [d1, d1, d2, d2]);
  }
  load(c: StampCtx): void {
    const r = this.r();
    const [a, b, p, q] = this.terminals;
    const j = c.x[this.branch];
    this.flow(c, 0, j);
    this.flow(c, 1, -j);
    this.flow(c, 2, -r * j);
    this.flow(c, 3, r * j);
    c.addJ(a, this.branch, 1); c.addJ(b, this.branch, -1);
    c.addJ(p, this.branch, -r); c.addJ(q, this.branch, r);
    c.addF(this.branch, c.e(a) - c.e(b) - r * (c.e(p) - c.e(q)));
    c.addJ(this.branch, a, 1); c.addJ(this.branch, b, -1);
    c.addJ(this.branch, p, -r); c.addJ(this.branch, q, r);
  }
}

/**
 * Resistor whose resistance follows its own temperature, R = R0·(1 + α·(T − T0)),
 * and which delivers its i²R loss as heat into a thermal node.
 */
export class HeatingResistor extends Element {
  constructor(name: string, a: number, b: number, th: number, readonly R0: Getter, readonly alpha: Getter, readonly T0: number) {
    super(name, 'converter', [a, b, th], ['electrical', 'electrical', 'thermal']);
  }
  resistance(T: number): number {
    return Math.max(this.R0() * (1 + this.alpha() * (T - this.T0)), 1e-6 * this.R0());
  }
  load(c: StampCtx): void {
    const [a, b, th] = this.terminals;
    const R0 = this.R0(), al = this.alpha();
    const dv = c.e(a) - c.e(b);
    const R = this.resistance(c.e(th));
    const i = dv / R;
    const q = (dv * dv) / R;
    const dRdT = R0 * al;
    const di_dT = (-dv * dRdT) / (R * R);
    const dq_dv = (2 * dv) / R;
    const dq_dT = (-dv * dv * dRdT) / (R * R);
    this.flow(c, 0, i);
    this.flow(c, 1, -i);
    this.flow(c, 2, -q);
    c.addJ(a, a, 1 / R); c.addJ(a, b, -1 / R); c.addJ(a, th, di_dT);
    c.addJ(b, a, -1 / R); c.addJ(b, b, 1 / R); c.addJ(b, th, -di_dT);
    c.addJ(th, a, -dq_dv); c.addJ(th, b, dq_dv); c.addJ(th, th, -dq_dT);
  }
}

const VT = 0.025852; // thermal voltage at 300 K

function pnjlim(vnew: number, vold: number, vt: number, vcrit: number): number {
  if (vnew > vcrit && Math.abs(vnew - vold) > 2 * vt) {
    if (vold > 0) {
      const arg = 1 + (vnew - vold) / vt;
      return arg > 0 ? vold + vt * Math.log(arg) : vcrit;
    }
    return vt * Math.log(vnew / vt);
  }
  return vnew;
}

/** Shockley diode with SPICE-style junction limiting. Used for LEDs. */
export class Diode extends Element {
  private vd = 0;
  private vdAccepted = 0;
  private limited = false;
  constructor(name: string, a: number, b: number, readonly Is: number, readonly nIdeal: number) {
    super(name, 'dissipative', [a, b], ['electrical', 'electrical']);
  }
  load(c: StampCtx): void {
    const [a, b] = this.terminals;
    const nvt = this.nIdeal * VT;
    const vcrit = nvt * Math.log(nvt / (Math.SQRT2 * this.Is));
    const v = c.e(a) - c.e(b);
    const vl = pnjlim(v, this.vd, nvt, vcrit);
    this.limited = Math.abs(v - vl) > 1e-6;
    this.vd = vl;
    const ex = Math.exp(Math.min(vl / nvt, 80));
    const g = (this.Is / nvt) * ex + 1e-12;
    const f = this.Is * (ex - 1) + g * (v - vl);
    this.flow(c, 0, f);
    this.flow(c, 1, -f);
    c.addJ(a, a, g); c.addJ(a, b, -g);
    c.addJ(b, a, -g); c.addJ(b, b, g);
  }
  isConverged(): boolean { return !this.limited; }
  accept(c: StampCtx): boolean {
    this.vdAccepted = c.e(this.terminals[0]) - c.e(this.terminals[1]);
    this.vd = this.vdAccepted;
    return false;
  }
  reset(): void { this.vd = 0; this.vdAccepted = 0; this.limited = false; }
}

/**
 * Control logic with no ports of its own: reads node efforts after each step and changes
 * discrete state (a 555's flip-flop). Returning true marks a discrete event.
 */
export class Logic extends Element {
  constructor(name: string, readonly onAccept: (e: (n: number) => number, t: number) => boolean, readonly onReset: () => void) {
    super(name, 'converter', [], []);
  }
  load(): void {}
  accept(c: StampCtx): boolean { return this.onAccept((n) => c.e(n), c.t); }
  reset(): void { this.onReset(); }
}

export { GROUND };
