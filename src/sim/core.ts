import { solveInPlace } from './linalg';

/**
 * Every physical quantity lives on a node as an effort (voltage, angular velocity, temperature)
 * and moves between nodes as a flow (current, torque, heat flow). Connecting ports adds
 * conservation automatically: the solver writes one flow-balance equation per node.
 */
export type Domain = 'electrical' | 'rotational' | 'translational' | 'thermal' | 'fluid';

/**
 * Fluid networks use pressure (Pa) and mass flow (kg/s). Their product is not power, so fluid
 * ports are left out of the energy ledger; couplings into a fluid network count as work leaving
 * (or entering) the ledger, like heat to ambient.
 */
export const isFluid = (d: Domain) => d === 'fluid';

export const GROUND = -1;

export type ElementKind =
  | 'source'       // delivers energy from outside the model (battery)
  | 'reservoir'    // absorbs heat into an infinite store (ambient air)
  | 'storage'      // capacitance, inertia, inductance, spring, heat capacity
  | 'dissipative'  // resistor, damper, diode
  | 'converter'    // ideal two-ports and heating resistors: power in = power out
  | 'transport';   // thermal conductance: heat passes, nothing is lost

export type Method = 'be' | 'trap';

export interface NodeInfo {
  id: string;
  domain: Domain;
  index: number;
}

export interface StampCtx {
  readonly x: Float64Array;
  readonly xPrev: Float64Array;
  readonly h: number;
  readonly t: number;
  readonly method: Method;
  e(node: number): number;
  ePrev(node: number): number;
  addF(row: number, v: number): void;
  addJ(row: number, col: number, v: number): void;
}

export abstract class Element {
  readonly flows: Float64Array;
  prevFlows: Float64Array;
  /** First branch unknown, assigned by the simulator when nBranch > 0. */
  branch = -1;
  readonly nBranch: number = 0;
  /** Energy absorbed through this element's ports since t = 0 (J). */
  absorbed = 0;

  constructor(
    readonly name: string,
    readonly kind: ElementKind,
    readonly terminals: number[],
    readonly domains: Domain[],
  ) {
    this.flows = new Float64Array(terminals.length);
    this.prevFlows = new Float64Array(terminals.length);
  }

  /** Add this element's flows to F and their derivatives to J at the current iterate. */
  abstract load(c: StampCtx): void;
  /** Called once per accepted step. Return true when a discrete change happened. */
  accept(_c: StampCtx): boolean { return false; }
  /** False while a nonlinear device is still limiting its own step (Newton must keep going). */
  isConverged(): boolean { return true; }
  /** Energy currently held, for storage elements (J). */
  stored(_e: (node: number) => number): number { return 0; }
  /** Restore initial internal state. */
  reset(): void {}

  protected flow(c: StampCtx, k: number, value: number): void {
    this.flows[k] = value;
    c.addF(this.terminals[k], value);
  }
}

export interface Ledger {
  supplied: number;
  toReservoir: number;
  dissipated: number;
  storedDelta: number;
  converterLoss: number;
  residual: number;
  /** Residual as a fraction of the energy that moved through the model. */
  relResidual: number;
  byElement: { el: Element; absorbed: number; storedDelta: number }[];
}

export type SimStatus = 'ok' | 'failed';

export class Simulator {
  readonly n: number;
  x: Float64Array;
  xPrev: Float64Array;
  t = 0;
  h: number;
  method: Method;
  status: SimStatus = 'ok';
  failure = '';
  lastIterations = 0;
  stepsTaken = 0;
  /** Set after any discrete event; the next step uses implicit Euler to avoid trapezoidal ringing. */
  private forceBE = true;
  private readonly x0: Float64Array;
  private readonly stored0: Float64Array;
  private readonly J: Float64Array;
  private readonly F: Float64Array;
  private readonly ctx: StampCtx;
  private cur: Float64Array;

  constructor(
    readonly nodes: NodeInfo[],
    readonly elements: Element[],
    opts: { h: number; method: Method; initial?: (nodeId: string) => number | undefined },
  ) {
    let branchCursor = nodes.length;
    for (const el of elements) {
      if (el.nBranch > 0) { el.branch = branchCursor; branchCursor += el.nBranch; }
    }
    this.n = branchCursor;
    this.h = opts.h;
    this.method = opts.method;
    this.x0 = new Float64Array(this.n);
    for (const nd of nodes) {
      const v = opts.initial?.(nd.id);
      if (v !== undefined) this.x0[nd.index] = v;
    }
    this.x = this.x0.slice();
    this.xPrev = this.x0.slice();
    this.cur = this.x;
    this.J = new Float64Array(this.n * this.n);
    this.F = new Float64Array(this.n);
    const self = this;
    this.ctx = {
      get x() { return self.cur; },
      get xPrev() { return self.xPrev; },
      get h() { return self.h; },
      get t() { return self.t + self.h; },
      get method() { return self.forceBE ? 'be' : self.method; },
      e: (node) => (node < 0 ? 0 : self.cur[node]),
      ePrev: (node) => (node < 0 ? 0 : self.xPrev[node]),
      addF: (row, v) => { if (row >= 0) self.F[row] += v; },
      addJ: (row, col, v) => { if (row >= 0 && col >= 0) self.J[row * self.n + col] += v; },
    };
    this.stored0 = new Float64Array(elements.length);
    this.captureStored0();
  }

  private captureStored0(): void {
    const e = (node: number) => (node < 0 ? 0 : this.x[node]);
    this.elements.forEach((el, i) => { this.stored0[i] = el.stored(e); });
  }

  reset(): void {
    this.x = this.x0.slice();
    this.xPrev = this.x0.slice();
    this.cur = this.x;
    this.t = 0;
    this.status = 'ok';
    this.failure = '';
    this.stepsTaken = 0;
    this.forceBE = true;
    for (const el of this.elements) {
      el.reset();
      el.absorbed = 0;
      el.flows.fill(0);
      el.prevFlows.fill(0);
    }
    this.captureStored0();
  }

  /** Notify the solver that a parameter or switch changed discontinuously. */
  markEvent(): void { this.forceBE = true; }

  effort(node: number): number { return node < 0 ? 0 : this.x[node]; }

  private assemble(x: Float64Array): void {
    this.cur = x;
    this.J.fill(0);
    this.F.fill(0);
    for (const el of this.elements) el.load(this.ctx);
  }

  /** Advance one step of size h. Returns false if Newton failed to converge. */
  step(): boolean {
    if (this.status === 'failed') return false;
    const n = this.n;
    const x = this.xPrev.slice();
    const dx = new Float64Array(n);
    const A = new Float64Array(n * n);
    let converged = false;
    let iter = 0;
    for (; iter < 60; iter++) {
      this.assemble(x);
      A.set(this.J);
      for (let i = 0; i < n; i++) dx[i] = -this.F[i];
      if (!solveInPlace(A, dx, n)) {
        return this.fail(`Singular system at t = ${(this.t + this.h).toFixed(6)} s. A node may be floating.`);
      }
      let worst = 0;
      for (let i = 0; i < n; i++) {
        if (!Number.isFinite(dx[i])) return this.fail('Solver produced a non-finite value.');
        x[i] += dx[i];
        const tol = 1e-9 + 1e-7 * Math.abs(x[i]);
        worst = Math.max(worst, Math.abs(dx[i]) / tol);
      }
      if (worst <= 1 && iter > 0 && this.elements.every((el) => el.isConverged())) { converged = true; break; }
    }
    this.lastIterations = iter + 1;
    if (!converged) return this.fail(`Newton did not converge at t = ${(this.t + this.h).toFixed(6)} s.`);

    // One more pass at the converged point records each element's port flows.
    this.assemble(x);
    this.accountEnergy(x);

    let event = false;
    for (const el of this.elements) { if (el.accept(this.ctx)) event = true; }
    for (const el of this.elements) el.prevFlows = el.flows.slice();
    this.xPrev = x;
    this.x = x;
    this.cur = x;
    this.t += this.h;
    this.stepsTaken++;
    this.forceBE = event;
    return true;
  }

  private fail(msg: string): boolean {
    this.status = 'failed';
    this.failure = msg;
    this.cur = this.x;
    return false;
  }

  /**
   * Energy through each port over the step, using the quadrature that matches the integrator:
   * e·f at the new point for implicit Euler, midpoint efforts times midpoint flows for trapezoidal.
   * With these rules the sum over all elements is zero (Tellegen), so any leftover in the ledger
   * is the integrator's own error inside storage elements.
   */
  private accountEnergy(x: Float64Array): void {
    const h = this.h;
    const trap = !this.forceBE && this.method === 'trap';
    for (const el of this.elements) {
      let w = 0;
      for (let k = 0; k < el.terminals.length; k++) {
        const node = el.terminals[k];
        if (node < 0 || el.domains[k] === 'fluid') continue;
        const f1 = el.flows[k];
        const f0 = el.prevFlows[k];
        if (el.domains[k] === 'thermal') {
          w += trap ? 0.5 * (f0 + f1) * h : f1 * h;
        } else {
          const e1 = x[node];
          const e0 = this.xPrev[node];
          w += trap ? 0.25 * (e0 + e1) * (f0 + f1) * h : e1 * f1 * h;
        }
      }
      el.absorbed += w;
    }
  }

  ledger(): Ledger {
    const e = (node: number) => this.effort(node);
    let supplied = 0, toReservoir = 0, dissipated = 0, storedDelta = 0, converterLoss = 0, basis = 0;
    const byElement: Ledger['byElement'] = [];
    this.elements.forEach((el, i) => {
      const sd = el.kind === 'storage' ? el.stored(e) - this.stored0[i] : 0;
      byElement.push({ el, absorbed: el.absorbed, storedDelta: sd });
      switch (el.kind) {
        case 'source': supplied -= el.absorbed; break;
        case 'reservoir': toReservoir += el.absorbed; break;
        case 'dissipative': dissipated += el.absorbed; break;
        case 'storage':
          storedDelta += sd;
          if (!el.domains.includes('thermal')) basis += Math.abs(this.stored0[i]);
          break;
        default: converterLoss += el.absorbed;
      }
    });
    const residual = supplied - toReservoir - dissipated - storedDelta - converterLoss;
    basis += Math.abs(supplied) + Math.abs(toReservoir);
    return {
      supplied, toReservoir, dissipated, storedDelta, converterLoss, residual,
      relResidual: basis > 1e-12 ? residual / basis : 0,
      byElement,
    };
  }
}
