import { Element, type Domain, type StampCtx } from './core';

type Getter = () => number;

/**
 * Ideal flow source: drives flow F from b to a through itself (current source, force, heat input,
 * mass-flow source). A positive F pushes flow into node a.
 */
export class FlowSource extends Element {
  constructor(name: string, a: number, b: number, domain: Domain, readonly F: (t: number) => number) {
    super(name, domain === 'fluid' ? 'transport' : 'source', [a, b], [domain, domain]);
  }
  load(c: StampCtx): void {
    const f = this.F(c.t);
    this.flow(c, 0, -f);
    this.flow(c, 1, f);
  }
}

/**
 * Square-root flow law for orifices, injectors, valves and turbulent pipe friction:
 * ṁ = K · Δp / √(|Δp| + p₀). For |Δp| ≫ p₀ this is K·√|Δp| (K = Cd·A·√(2ρ)); near zero it is
 * linear, which keeps Newton's method well behaved when a valve closes.
 */
export class SqrtFlow extends Element {
  constructor(name: string, a: number, b: number, readonly K: (t: number) => number, readonly p0 = 2000) {
    super(name, 'transport', [a, b], ['fluid', 'fluid']);
  }
  static flow(K: number, dp: number, p0: number): [number, number] {
    const s = Math.abs(dp) + p0;
    const r = Math.sqrt(s);
    return [(K * dp) / r, (K * (Math.abs(dp) / 2 + p0)) / (s * r)];
  }
  load(c: StampCtx): void {
    const [a, b] = this.terminals;
    const [f, g] = SqrtFlow.flow(Math.max(0, this.K(c.t)), c.e(a) - c.e(b), this.p0);
    this.flow(c, 0, f);
    this.flow(c, 1, -f);
    c.addJ(a, a, g); c.addJ(a, b, -g);
    c.addJ(b, a, -g); c.addJ(b, b, g);
  }
}

/**
 * Two-port that turns an effort on one side into a flow on the other:
 * flow into a = g1·Δe(c,d), flow into c = −g2·Δe(a,b).
 * A positive-displacement pump (rotational → fluid): g1 = D (torque = D·Δp), g2 = ρ·D (ṁ = ρ·D·ω).
 * A hydraulic cylinder (fluid → translational): g1 = ρ·A (ṁ = ρ·A·v), g2 = A (F = A·Δp).
 */
export class Gyrator extends Element {
  constructor(name: string, a: number, b: number, c2: number, d: number, d1: Domain, d2: Domain, readonly g1: Getter, readonly g2: Getter) {
    super(name, d1 === 'fluid' || d2 === 'fluid' ? 'reservoir' : 'converter', [a, b, c2, d], [d1, d1, d2, d2]);
  }
  load(c: StampCtx): void {
    const [a, b, p, q] = this.terminals;
    const g1 = this.g1(), g2 = this.g2();
    const de1 = c.e(a) - c.e(b), de2 = c.e(p) - c.e(q);
    this.flow(c, 0, g1 * de2);
    this.flow(c, 1, -g1 * de2);
    this.flow(c, 2, -g2 * de1);
    this.flow(c, 3, g2 * de1);
    c.addJ(a, p, g1); c.addJ(a, q, -g1); c.addJ(b, p, -g1); c.addJ(b, q, g1);
    c.addJ(p, a, -g2); c.addJ(p, b, g2); c.addJ(q, a, g2); c.addJ(q, b, -g2);
  }
}

/**
 * A rigid link on a rotational joint with its centre of mass at distance l, under gravity.
 * θ is measured from horizontal; gravity torque m·g·l·cos θ resists lifting.
 * The link stores potential energy m·g·l·sin θ.
 */
export class GravityLink extends Element {
  theta: number;
  private thetaNew: number;
  constructor(name: string, a: number, readonly m: Getter, readonly l: Getter, readonly theta0: Getter) {
    super(name, 'storage', [a, -1], ['rotational', 'rotational']);
    this.theta = theta0();
    this.thetaNew = this.theta;
  }
  load(c: StampCtx): void {
    const a = this.terminals[0];
    const w = c.e(a);
    const trap = c.method === 'trap';
    const k = trap ? c.h / 2 : c.h;
    this.thetaNew = this.theta + (trap ? k * (w + c.ePrev(a)) : k * w);
    const mgl = this.m() * 9.80665 * this.l();
    const tau = mgl * Math.cos(this.thetaNew);
    this.flow(c, 0, tau);
    this.flow(c, 1, -tau);
    c.addJ(a, a, -mgl * Math.sin(this.thetaNew) * k);
  }
  accept(): boolean { this.theta = this.thetaNew; return false; }
  stored(): number { return this.m() * 9.80665 * this.l() * Math.sin(this.theta); }
  reset(): void { this.theta = this.theta0(); this.thetaNew = this.theta; }
}

// ------------------------------------------------------------------ rocket thrust chamber

const G0 = 9.80665;

/** Exit/chamber pressure ratio for a nozzle area ratio ε (supersonic branch, isentropic). */
export function exitPressureRatio(eps: number, gamma: number): number {
  const g = gamma;
  const areaRatio = (M: number) => (1 / M) * Math.pow((2 / (g + 1)) * (1 + ((g - 1) / 2) * M * M), (g + 1) / (2 * (g - 1)));
  let lo = 1.0001, hi = 20;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (areaRatio(mid) < eps) lo = mid; else hi = mid;
  }
  const M = (lo + hi) / 2;
  return Math.pow(1 + ((g - 1) / 2) * M * M, -g / (g - 1));
}

export function gammaFn(g: number): number {
  return Math.sqrt(g) * Math.pow(2 / (g + 1), (g + 1) / (2 * (g - 1)));
}

/** Ideal vacuum-free thrust coefficient at chamber pressure pc with ambient pa. */
export function thrustCoefficient(pc: number, pa: number, eps: number, g: number): number {
  const pr = exitPressureRatio(eps, g);
  const mom = gammaFn(g) * Math.sqrt(((2 * g) / (g - 1)) * (1 - Math.pow(pr, (g - 1) / g)));
  return mom + (pr - pa / Math.max(pc, 1)) * eps;
}

export interface ChamberParams {
  /** Injector coefficients K = Cd·A·√(2ρ), oxidizer and fuel. */
  Kox: Getter;
  Kfu: Getter;
  At: Getter;
  eps: Getter;
  V: Getter;
  gamma: number;
  /** Peak characteristic velocity (m/s), its mixture ratio, and combustion efficiency. */
  cstarMax: Getter;
  mrOpt: Getter;
  etaC: Getter;
  /** Combustion time lag (s): injected propellant becomes hot gas this much later. */
  tau: Getter;
  /** Ignition time (s); before it the chamber only holds cold propellant vapour. */
  tIgnite: Getter;
  /** Gas-side heat-transfer coefficient at the reference pressure (W/m²K), wall area (m²). */
  hRef: Getter;
  pcRef: Getter;
  wallArea: Getter;
  ambient: Getter;
}

export interface ChamberState {
  pc: number;
  mdotOx: number;
  mdotFu: number;
  mdotGen: number;
  mr: number;
  cstar: number;
  thrust: number;
  isp: number;
  cf: number;
  burning: boolean;
  heat: number;
  impulse: number;
}

/**
 * Liquid bipropellant thrust chamber: two injectors feed a gas volume that empties through a
 * choked throat. Propellant turns into hot gas after a combustion time lag τ (the classic
 * Summerfield model), which is what lets a soft injector "chug". c* follows a curve fit of
 * mixture ratio; thrust = Cf·Pc·At with Cf from the isentropic nozzle relations. Heat flux to
 * the wall scales with Pc^0.8 (Bartz-like) and leaves through the thermal port.
 */
export class ThrustChamber extends Element {
  readonly state: ChamberState = { pc: 0, mdotOx: 0, mdotFu: 0, mdotGen: 0, mr: 0, cstar: 0, thrust: 0, isp: 0, cf: 0, burning: false, heat: 0, impulse: 0 };
  private hist: { t: number; ox: number; fu: number }[] = [{ t: 0, ox: 0, fu: 0 }];
  /** Combustion state at the last accepted step: a flame holds itself, but lighting needs the igniter. */
  private lit = false;
  /** Injection rates averaged over about 10 ms, which decide whether a lit flame blows out. */
  private avg = { ox: 0, fu: 0 };
  /** How long the igniter burns after it fires (s). */
  static readonly IGNITER_SECONDS = 0.5;

  constructor(name: string, ox: number, fu: number, chamber: number, wall: number, readonly p: ChamberParams) {
    super(name, 'source', [ox, fu, chamber, wall], ['fluid', 'fluid', 'fluid', 'thermal']);
  }

  /** Propellant flows that were injected τ seconds before time t. */
  private delayed(t: number): { ox: number; fu: number } {
    const target = t - this.p.tau();
    const h = this.hist;
    if (target <= h[0].t) return { ox: h[0].ox, fu: h[0].fu };
    for (let i = h.length - 1; i > 0; i--) {
      if (h[i - 1].t <= target) {
        const a = h[i - 1], b = h[i];
        const s = b.t > a.t ? Math.min(1, (target - a.t) / (b.t - a.t)) : 1;
        return { ox: a.ox + (b.ox - a.ox) * s, fu: a.fu + (b.fu - a.fu) * s };
      }
    }
    return { ox: h[h.length - 1].ox, fu: h[h.length - 1].fu };
  }

  cstarFor(ox: number, fu: number, t: number, lit: boolean): { cstar: number; burning: boolean; mr: number } {
    const mr = fu > 1e-6 ? ox / fu : ox > 1e-6 ? 99 : 0;
    // A flame needs a few percent of design flow at a burnable mixture ratio.
    const minFlow = (0.02 * this.p.pcRef() * this.p.At()) / 1500;
    const ignite = t >= this.p.tIgnite() && t <= this.p.tIgnite() + ThrustChamber.IGNITER_SECONDS;
    // An established flame rides through brief mixture swings (as in a chug); lighting needs more.
    const a = this.avg;
    const burning = lit
      ? a.ox > minFlow / 2 && a.fu > minFlow / 2 && a.ox / a.fu > 0.2 && a.ox / a.fu < 8
      : ignite && ox > minFlow && fu > minFlow && mr > 0.4 && mr < 4;
    if (!burning) return { cstar: 420, burning, mr };
    const x = mr / this.p.mrOpt() - 1;
    const cstar = this.p.etaC() * this.p.cstarMax() * Math.max(0.55, 1 - 0.16 * x * x);
    return { cstar, burning, mr };
  }

  load(c: StampCtx): void {
    const [ox, fu, ch, wall] = this.terminals;
    const pc = c.e(ch);
    const [fOx, gOx] = SqrtFlow.flow(this.p.Kox(), c.e(ox) - pc, 2000);
    const [fFu, gFu] = SqrtFlow.flow(this.p.Kfu(), c.e(fu) - pc, 2000);
    const d = this.delayed(c.t);
    const { cstar, burning } = this.cstarFor(d.ox, d.fu, c.t, this.lit);
    const At = this.p.At();
    const g = At / cstar;
    const C = this.p.V() / Math.pow(gammaFn(this.p.gamma) * cstar, 2);
    // Chamber gas mass balance (implicit Euler; the chamber time constant is about a millisecond):
    // V/(RT)·dPc/dt = ṁ_gen − Pc·At/c*. Nothing else connects to this node.
    // Burning, propellant turns to gas τ after injection and the throat is choked. Cold, the
    // injected liquid simply passes through and the chamber vents to ambient.
    const cG = C / c.h;
    const back = burning ? 0 : this.p.ambient();
    const gen = burning ? Math.max(0, d.ox) + Math.max(0, d.fu) : fOx + fFu;
    const fCh = cG * (pc - c.ePrev(ch)) + g * (pc - back) - gen;
    this.flow(c, 0, fOx);
    this.flow(c, 1, fFu);
    this.flow(c, 2, fCh);
    c.addJ(ox, ox, gOx); c.addJ(ox, ch, -gOx);
    c.addJ(fu, fu, gFu); c.addJ(fu, ch, -gFu);
    c.addJ(ch, ch, cG + g);
    if (!burning) { c.addJ(ch, ox, -gOx); c.addJ(ch, fu, -gFu); c.addJ(ch, ch, gOx + gFu); }
    // Gas-side heat to the wall while burning; adiabatic wall temperature ≈ 0.9·Tc, Tc = (Γ·c*)²/R.
    const tw = c.e(wall);
    const h = burning ? this.p.hRef() * Math.pow(Math.max(pc, 0) / this.p.pcRef(), 0.8) : 0;
    const taw = (0.9 * Math.pow(gammaFn(this.p.gamma) * cstar, 2)) / 378;
    const q = h * this.p.wallArea() * (taw - tw);
    this.flow(c, 3, -q);
    c.addJ(wall, wall, h * this.p.wallArea());
  }

  accept(c: StampCtx): boolean {
    const [, , ch] = this.terminals;
    const pc = c.e(ch);
    const ox = this.flows[0], fu = this.flows[1];
    this.hist.push({ t: c.t, ox, fu });
    const k = Math.min(1, c.h / 0.01);
    this.avg.ox += (ox - this.avg.ox) * k;
    this.avg.fu += (fu - this.avg.fu) * k;
    const keep = c.t - this.p.tau() - 0.01;
    while (this.hist.length > 2 && this.hist[1].t < keep) this.hist.shift();
    const d = this.delayed(c.t);
    const { cstar, burning, mr } = this.cstarFor(d.ox, d.fu, c.t, this.lit);
    this.lit = burning;
    const cf = burning ? thrustCoefficient(pc, this.p.ambient(), this.p.eps(), this.p.gamma) : 0;
    const thrust = Math.max(0, cf * pc * this.p.At());
    const mdotOut = ((pc - (burning ? 0 : this.p.ambient())) * this.p.At()) / cstar;
    Object.assign(this.state, {
      pc, mdotOx: ox, mdotFu: fu, mdotGen: d.ox + d.fu, mr, cstar, cf, thrust, burning,
      isp: mdotOut > 1e-4 ? thrust / (mdotOut * G0) : 0,
      heat: -this.flows[3],
      impulse: this.state.impulse + thrust * c.h,
    });
    return false;
  }

  reset(): void {
    this.hist = [{ t: 0, ox: 0, fu: 0 }];
    this.lit = false;
    this.avg = { ox: 0, fu: 0 };
    Object.assign(this.state, { pc: 0, mdotOx: 0, mdotFu: 0, mdotGen: 0, mr: 0, cstar: 0, thrust: 0, isp: 0, cf: 0, burning: false, heat: 0, impulse: 0 });
  }
}

// ------------------------------------------------------------------ sampled PID controller

export interface PidState {
  ref: number;
  meas: number;
  u: number;
  integ: number;
  lastErr: number;
  dFilt: number;
  saturated: boolean;
}

/**
 * Digital PID that samples once per solver step: measures an angle by integrating the sensed
 * shaft speed, follows a reference profile, and sets the drive voltage used on the next step.
 */
export class PidLogic extends Element {
  readonly s: PidState = { ref: 0, meas: 0, u: 0, integ: 0, lastErr: 0, dFilt: 0, saturated: false };
  constructor(
    name: string,
    readonly sense: number,
    readonly gains: { kp: Getter; ki: Getter; kd: Getter; vmax: Getter; ratio: Getter; theta0: Getter },
    readonly reference: (t: number) => number,
  ) {
    super(name, 'converter', [], []);
    this.s.meas = gains.theta0();
  }
  load(): void {}
  accept(c: StampCtx): boolean {
    const s = this.s;
    s.meas += c.h * (this.sense >= 0 ? c.e(this.sense) : 0);
    s.ref = this.reference(c.t);
    const err = s.ref - s.meas;
    const d = (err - s.lastErr) / c.h;
    s.dFilt += (d - s.dFilt) * Math.min(1, c.h / 0.004);
    s.lastErr = err;
    const vmax = this.gains.vmax();
    const trial = this.gains.kp() * err + this.gains.ki() * (s.integ + err * c.h) + this.gains.kd() * s.dFilt;
    s.saturated = Math.abs(trial) > vmax;
    if (!s.saturated) s.integ += err * c.h;
    s.u = Math.max(-vmax, Math.min(vmax, this.gains.kp() * err + this.gains.ki() * s.integ + this.gains.kd() * s.dFilt));
    return false;
  }
  reset(): void { Object.assign(this.s, { ref: 0, meas: this.gains.theta0(), u: 0, integ: 0, lastErr: 0, dFilt: 0, saturated: false }); }
}
