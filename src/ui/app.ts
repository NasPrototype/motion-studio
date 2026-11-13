import { type Domain, type Element, Simulator } from '../sim/core';
import { Capacitance, Inductance } from '../sim/elements';
import { type Component, type Group, type Param, type Port, portEffortText, portFlow, portFlowText } from '../sim/components';
import { SCENES, type SceneDef, type SceneInstance, type Trace } from '../sim/scenes';
import { LIBRARY, PART_TYPES } from '../sim/library';
import { type Compiled, compileProject, nextId, type Project, STARTER, wireError } from '../sim/project';
import { si } from '../sim/units';
import { DOMAIN_LABEL, type EditorHandlers, PART_DRAG_MIME, Viewport, type CameraView, type Palette } from '../view/viewport';
import { IntegrationsPanel } from '../integrations/panel';
import { openPhotoDialog } from '../photo/dialog';
import { Scopes, type ScopeColors } from './scopes';
import { $, css, download, h, storage, toast } from './dom';

const GROUPS: Group[] = ['Electrical', 'Control', 'Couplings', 'Rotational', 'Translational', 'Fluid', 'Thermal'];
const GROUP_SWATCH: Record<Group, string> = {
  Electrical: 'var(--d-electrical)',
  Control: 'var(--text-2)',
  Couplings: 'transparent',
  Rotational: 'var(--d-rotational)',
  Translational: 'var(--d-translational)',
  Fluid: 'var(--d-fluid)',
  Thermal: 'var(--d-thermal)',
};
const STEP_SECONDS = 0.01;
const SAMPLE_EVERY = 0.005;
const PROJECTS_KEY = 'ms-projects';
const MAX_PLOTS = 4;

type Current = { kind: 'builtin'; def: SceneDef } | { kind: 'project'; project: Project };
interface PlotSpec { component: string; port: string; kind: 'effort' | 'flow' }
type Health = 'ok' | 'warn' | 'crit' | 'fail';

function displayValue(p: Param): string {
  const d = p.value / p.scale - p.offset;
  const a = Math.abs(d);
  if (a !== 0 && (a < 1e-3 || a >= 1e6)) return Number(d.toPrecision(4)).toExponential();
  return Number(d.toPrecision(6)).toString();
}

function validProject(x: unknown): x is Project {
  const p = x as Project;
  return !!p && p.version === 1 && typeof p.id === 'string' && typeof p.name === 'string' && Array.isArray(p.parts) && Array.isArray(p.wires);
}

export class App {
  private current!: Current;
  private inst!: SceneInstance;
  private compiled: Compiled | null = null;
  private sim!: Simulator;
  private owner = new Map<Element, Component>();
  private running = false;
  private editing = false;
  private selection: string | null = null;
  private selectedWire: string | null = null;
  private pendingWire: string | null = null;
  private projects: Project[];
  private plotted: PlotSpec[] = [];
  private readonly viewport: Viewport;
  private readonly scopes: Scopes;
  private readonly integrations: IntegrationsPanel;
  private carry = 0;
  private lastSample = -Infinity;
  private pendingSimDt = 0;
  private rate = 0;
  private uiAcc = 1;
  private live: { update(): void }[] = [];
  private treeValues = new Map<string, HTMLElement>();
  private confirmDelete: string | null = null;

  constructor() {
    this.applyTheme(this.storedTheme());
    this.projects = storage.get<unknown[]>(PROJECTS_KEY, []).filter(validProject);
    if (!this.projects.length) this.projects = [structuredClone(STARTER)];
    this.viewport = new Viewport($('viewport'), $('callouts'), this.palette(), (id) => this.select(id));
    this.scopes = new Scopes($<HTMLCanvasElement>('scope-canvas'));
    this.integrations = new IntegrationsPanel({
      sim: () => this.sim,
      components: () => this.inst.components,
      traces: () => this.activeTraces(),
      sceneName: () => this.currentName(),
      overlay: (label, t, v) => this.scopes.pushHardware(label, t, v),
      inputTargets: () => this.inputTargets(),
      exportGLB: () => this.viewport.exportGLB(),
      setStatus: (s) => this.integrationStatus(s),
      log: (lines, status) => {
        $('hw-status').textContent = status;
        const log = $('hw-log');
        log.textContent = lines.slice(-300).join('\n');
        log.scrollTop = log.scrollHeight;
      },
    });
    this.bindChrome();
    this.renderLibrary();
  }

  start(): void {
    const hash = decodeURIComponent(location.hash.slice(1));
    if (hash.startsWith('project:') && this.projects.some((p) => p.id === hash.slice(8))) this.open(hash);
    else this.open(SCENES.find((s) => s.id === hash)?.id ?? SCENES[0].id);
    this.setRunning(true);
    let last = performance.now();
    const tick = (now: number) => {
      const wallDt = Math.min(0.1, (now - last) / 1000);
      last = now;
      this.frame(wallDt);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  // ---------------------------------------------------------------- scenes and projects

  /** Open a built-in example by id, or a saved circuit as `project:<id>`. */
  private open(key: string): void {
    this.setEditing(false, true);
    this.selection = null;
    this.selectedWire = null;
    this.plotted = [];
    if (key.startsWith('project:')) {
      const project = this.projects.find((p) => p.id === key.slice(8));
      if (!project) return;
      this.current = { kind: 'project', project };
      this.compiled = compileProject(project);
      this.install(this.compiled.scene, {});
      this.select(project.parts.find((p) => p.type !== 'ground')?.id ?? null);
    } else {
      const def = SCENES.find((s) => s.id === key) ?? SCENES[0];
      this.current = { kind: 'builtin', def };
      this.compiled = null;
      $<HTMLSelectElement>('sel-method').value = def.method;
      this.install(def.create(), {});
      this.select(def.defaultSelection);
    }
    this.renderSceneSelect();
  }

  private install(inst: SceneInstance, opts: { keepCamera?: boolean }): void {
    this.inst = inst;
    const dt = Number($<HTMLSelectElement>('sel-dt').value) || 5e-4;
    const method = $<HTMLSelectElement>('sel-method').value as 'be' | 'trap';
    this.sim = new Simulator(inst.nodes, inst.elements, { h: dt, method, initial: inst.initial });
    this.owner.clear();
    for (const c of inst.components) for (const el of c.elements) this.owner.set(el, c);
    this.viewport.load(inst, opts);
    this.applyTraces();
    this.resetCounters();
    this.renderTree();
    this.renderSceneList();
    this.renderNote();
    this.renderLegend();
    this.renderProblems();
    if (this.selection && !inst.components.some((c) => c.id === this.selection)) this.selection = null;
    this.viewport.setSelection(this.selection);
    this.renderInspector();
    this.integrations.sceneChanged();
    if (this.editing) this.viewport.setEditor(this.editorHandlers());
    this.updateUi();
  }

  private get project(): Project | null {
    return this.current?.kind === 'project' ? this.current.project : null;
  }

  private currentName(): string {
    return this.current.kind === 'project' ? this.current.project.name : this.current.def.name;
  }

  private saveProjects(): void {
    storage.set(PROJECTS_KEY, this.projects);
  }

  /** Recompile the open circuit after an edit, keeping the camera, selection and edit mode. */
  private commit(): void {
    const p = this.project;
    if (!p) return;
    this.saveProjects();
    this.compiled = compileProject(p);
    this.install(this.compiled.scene, { keepCamera: true });
    this.viewport.setSelectedWire(this.selectedWire);
    this.renderSceneSelect();
  }

  private addProject(p: Project, edit: boolean): void {
    this.projects.push(p);
    this.saveProjects();
    this.open(`project:${p.id}`);
    if (edit) this.setEditing(true);
  }

  private newProject(): void {
    const p: Project = { version: 1, id: `c${Date.now().toString(36)}`, name: `Circuit ${this.projects.length + 1}`, parts: [], wires: [] };
    this.addProject(p, true);
    toast('Empty circuit. Drag parts in from the Library.');
  }

  private resetCounters(): void {
    this.carry = 0;
    this.lastSample = -Infinity;
    this.pendingSimDt = 0;
    this.scopes.clear();
    $('banner').hidden = true;
  }

  private reset(): void {
    this.sim.reset();
    this.resetCounters();
    this.integrations.engine.resetAngles();
    this.updateUi();
  }

  private setRunning(on: boolean): void {
    if (on && this.editing) on = false;
    this.running = on;
    $('btn-run').setAttribute('aria-pressed', String(on));
    $('run-label').textContent = on ? 'Running' : 'Paused';
  }

  // ---------------------------------------------------------------- editing

  private setEditing(on: boolean, quiet = false): void {
    if (on && !this.project) {
      if (!quiet) toast('Examples are read-only. Open a circuit from Scenes › My circuits, or start a new one.', 'error');
      on = false;
    }
    const was = this.editing;
    this.editing = on;
    this.pendingWire = null;
    $('mode-simulate').setAttribute('aria-pressed', String(!on));
    $('mode-edit').setAttribute('aria-pressed', String(on));
    document.documentElement.dataset.editing = String(on);
    $('hint').textContent = on
      ? 'Drag parts to move · click a port, then another, to wire · R rotates · Delete removes · Esc cancels'
      : 'Drag to orbit · right-drag to pan · scroll to zoom';
    if (!this.viewport) return;
    this.viewport.setEditor(on ? this.editorHandlers() : null);
    if (on) { this.setRunning(false); this.switchRailTab('library'); }
    else if (was && !quiet) { this.reset(); this.setRunning(true); this.switchRailTab('model'); }
  }

  private editorHandlers(): EditorHandlers {
    return {
      ports: this.compiled?.ports ?? new Map(),
      onPortClick: (key) => this.portClick(key),
      onWireClick: (id) => { this.selectedWire = id; this.selection = null; this.viewport.setSelection(null); this.viewport.setSelectedWire(id); this.renderTree(); this.renderInspector(); },
      onEmptyClick: () => { this.cancelWire(); this.selectedWire = null; this.viewport.setSelectedWire(null); this.renderInspector(); },
      onMove: (part, x, z) => {
        const p = this.project?.parts.find((q) => q.id === part);
        if (!p) return;
        p.pos = [x, z];
        this.selection = part;
        this.commit();
      },
      onDrop: (type, x, z) => this.addPart(type, [x, z]),
    };
  }

  private portClick(key: string): void {
    const p = this.project;
    if (!p) return;
    const [part, port] = key.split('.');
    if (!this.pendingWire) {
      this.pendingWire = key;
      this.viewport.setPendingWire(key);
      const domain = this.compiled?.ports.get(key)?.domain ?? 'electrical';
      toast(`Wiring from ${part}.${port}. Click another ${domain} port, or press Esc.`);
      return;
    }
    if (this.pendingWire === key) { this.cancelWire(); return; }
    const [ap, aq] = this.pendingWire.split('.');
    const a = { part: ap, port: aq }, b = { part, port };
    const err = wireError(p, a, b);
    if (err) { toast(err, 'error'); return; }
    let n = p.wires.length + 1;
    while (p.wires.some((w) => w.id === `w${n}`)) n++;
    p.wires.push({ id: `w${n}`, a, b });
    this.pendingWire = null;
    this.viewport.setPendingWire(null);
    toast(`Connected ${ap}.${aq} to ${part}.${port}.`);
    this.commit();
  }

  private cancelWire(): void {
    if (!this.pendingWire) return;
    this.pendingWire = null;
    this.viewport.setPendingWire(null);
  }

  private addPart(type: string, pos?: [number, number]): void {
    const p = this.project;
    const t = PART_TYPES.get(type);
    if (!t) return;
    if (!p) { toast('Examples are read-only. Start a new circuit to add parts.', 'error'); return; }
    if (!this.editing) this.setEditing(true);
    let at = pos ?? this.viewport.centerPoint();
    if (!pos) {
      const clear = (q: [number, number]) => p.parts.every((x) => Math.hypot(x.pos[0] - q[0], x.pos[1] - q[1]) > (PART_TYPES.get(x.type)?.footprint ?? 2) + t.footprint);
      for (let i = 0; i < 40 && !clear(at); i++) at = [at[0] + t.footprint * 1.5 * Math.cos(i * 1.3), at[1] + t.footprint * 1.5 * Math.sin(i * 1.3)];
      at = [Math.round(at[0] * 2) / 2, Math.round(at[1] * 2) / 2];
    }
    const id = nextId(p, t.prefix);
    p.parts.push({ id, type, pos: at, rot: 0, params: {} });
    this.selection = id;
    this.selectedWire = null;
    this.commit();
    toast(`Added ${t.name} ${id}. Click one of its ports to start a wire.`);
  }

  private deleteSelected(): void {
    const p = this.project;
    if (!p) return;
    if (this.selectedWire) {
      p.wires = p.wires.filter((w) => w.id !== this.selectedWire);
      toast(`Removed wire ${this.selectedWire}.`);
      this.selectedWire = null;
      this.commit();
      return;
    }
    const id = this.selection;
    if (!id || !p.parts.some((x) => x.id === id)) return;
    p.parts = p.parts.filter((x) => x.id !== id);
    p.wires = p.wires.filter((w) => w.a.part !== id && w.b.part !== id);
    this.selection = null;
    toast(`Removed ${id} and its wires.`);
    this.commit();
  }

  private rotateSelected(): void {
    const part = this.project?.parts.find((x) => x.id === this.selection);
    if (!part) return;
    part.rot = (part.rot + Math.PI / 2) % (Math.PI * 2);
    this.commit();
  }

  // ---------------------------------------------------------------- loop

  private frame(wallDt: number): void {
    let simDt = this.pendingSimDt;
    this.pendingSimDt = 0;
    if (this.running && this.sim.status === 'ok') {
      const target = wallDt + this.carry;
      const steps = Math.floor(target / this.sim.h);
      this.carry = target - steps * this.sim.h;
      const t0 = performance.now();
      let done = 0;
      while (done < steps) {
        if (!this.stepOnce()) break;
        done++;
        if (performance.now() - t0 > 12) { this.carry = 0; break; }
      }
      simDt += done * this.sim.h;
      const inst = wallDt > 0 ? (done * this.sim.h) / wallDt : 0;
      this.rate = this.rate * 0.9 + inst * 0.1;
    }
    this.viewport.frame(this.sim, simDt, wallDt);
    this.integrations.tick(simDt, wallDt);
    this.scopes.draw(this.sim.t, this.scopeColors());
    this.uiAcc += wallDt;
    if (this.uiAcc >= 0.1) { this.uiAcc = 0; this.updateUi(); }
  }

  private stepOnce(): boolean {
    const ok = this.sim.step();
    if (!ok) { this.showFailure(); return false; }
    if (this.sim.t - this.lastSample >= SAMPLE_EVERY - 1e-12) {
      this.lastSample = this.sim.t;
      this.scopes.push(this.sim.t, this.activeTraces().map((tr) => tr.get(this.sim)));
    }
    return true;
  }

  private stepFrame(): void {
    if (this.editing) return;
    this.setRunning(false);
    const n = Math.max(1, Math.round(STEP_SECONDS / this.sim.h));
    let done = 0;
    for (; done < n; done++) if (!this.stepOnce()) break;
    this.pendingSimDt += done * this.sim.h;
    this.updateUi();
  }

  private showFailure(): void {
    this.setRunning(false);
    const b = $('banner');
    b.replaceChildren(h('b', { textContent: 'Solver stopped. ' }), this.sim.failure, ' Press Reset to start again.');
    b.hidden = false;
  }

  // ---------------------------------------------------------------- traces

  private resolvePlot(s: PlotSpec): Trace | null {
    const c = this.inst.components.find((x) => x.id === s.component);
    const port = c?.ports.find((x) => x.name === s.port);
    if (!c || !port) return null;
    const node = port.node;
    if (s.kind === 'effort') {
      if (port.domain === 'rotational') return { label: `${c.id} ${port.name} speed`, unit: 'rpm', domain: 'rotational', get: (sim) => (sim.effort(node) * 60) / (2 * Math.PI) };
      if (port.domain === 'thermal') return { label: `${c.id} ${port.name} temperature`, unit: '°C', domain: 'thermal', get: (sim) => sim.effort(node) - 273.15 };
      return { label: `${c.id} ${port.name} voltage`, unit: 'V', domain: 'electrical', get: (sim) => sim.effort(node) };
    }
    const unit = port.domain === 'rotational' ? 'N·m' : port.domain === 'thermal' ? 'W' : 'A';
    const name = port.domain === 'rotational' ? 'torque in' : port.domain === 'thermal' ? 'heat in' : 'current in';
    return { label: `${c.id} ${port.name} ${name}`, unit, domain: port.domain, get: () => portFlow(c, port) };
  }

  private activeTraces(): Trace[] {
    const mine = this.plotted.map((p) => this.resolvePlot(p)).filter((t): t is Trace => !!t);
    return mine.length ? mine : this.inst.traces;
  }

  private applyTraces(): void {
    this.scopes.setTraces(this.activeTraces());
    this.lastSample = -Infinity;
    $('btn-scene-traces').hidden = !this.plotted.length;
  }

  private togglePlot(spec: PlotSpec): void {
    const i = this.plotted.findIndex((p) => p.component === spec.component && p.port === spec.port && p.kind === spec.kind);
    if (i >= 0) this.plotted.splice(i, 1);
    else {
      this.plotted.push(spec);
      if (this.plotted.length > MAX_PLOTS) this.plotted.shift();
    }
    this.applyTraces();
    this.renderInspector();
  }

  // ---------------------------------------------------------------- periodic UI

  private updateUi(): void {
    $('ro-time').textContent = `${this.sim.t.toFixed(3)} s`;
    $('ro-rate').textContent = this.running && this.sim.status === 'ok' ? `${this.rate.toFixed(2)}× real time` : this.editing ? 'editing' : 'paused';
    for (const c of this.inst.components) {
      const v = this.treeValues.get(c.id);
      if (v) v.textContent = c.summary(this.sim);
    }
    for (const l of this.live) l.update();
    this.renderLedger();
  }

  private health(rel: number): Health {
    if (this.sim.status === 'failed') return 'fail';
    const a = Math.abs(rel);
    return a < 1e-3 ? 'ok' : a < 1e-2 ? 'warn' : 'crit';
  }

  private renderLedger(): void {
    const L = this.sim.ledger();
    const state = this.health(L.relResidual);
    const pct = si(L.relResidual * 100, '%');
    $('energy-pill').dataset.state = state;
    $('energy-value').textContent = state === 'fail' ? 'stopped' : pct;

    const sources = new Map<string, number>();
    const dissipated = new Map<string, number>();
    const reservoirs = new Map<string, number>();
    const hydraulic = new Map<string, number>();
    const stored = new Map<string, { v: number; ids: Set<string> }>();
    const add = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);
    for (const { el, absorbed, storedDelta } of L.byElement) {
      // Pressure × mass flow is not power, so all-fluid elements carry no energy in the ledger.
      if (el.domains.length && el.domains.every((d) => d === 'fluid')) continue;
      const c = this.owner.get(el);
      const name = c ? `${c.name} · ${c.id}` : 'Leakage';
      if (el.kind === 'reservoir' && el.domains.includes('fluid')) { add(hydraulic, name, absorbed); continue; }
      if (el.kind === 'source') add(sources, name, -absorbed);
      else if (el.kind === 'dissipative') { if (c || Math.abs(absorbed) > 1e-9) add(dissipated, name, absorbed); }
      else if (el.kind === 'reservoir') add(reservoirs, name, absorbed);
      else if (el.kind === 'storage') {
        const cat = storageCategory(el);
        const s = stored.get(cat) ?? { v: 0, ids: new Set<string>() };
        s.v += storedDelta;
        if (c) s.ids.add(c.id);
        stored.set(cat, s);
      }
    }
    const row = (label: string, v: number, strong = false) =>
      h('div', { className: `ledger-row${strong ? ' strong' : ''}` }, h('span', { textContent: label }), h('span', { className: 'mono', textContent: si(v, 'J') }));
    const rows: HTMLElement[] = [h('div', { className: 'ledger-title', textContent: 'Energy since t = 0' })];
    for (const [k, v] of sources) rows.push(row(`Supplied by ${k}`, v, true));
    if (stored.size) {
      rows.push(h('div', { className: 'ledger-sub', textContent: 'Stored' }));
      for (const [k, s] of stored) rows.push(row(`${k} · ${[...s.ids].join(', ')}`, s.v));
    }
    if (dissipated.size || reservoirs.size) {
      rows.push(h('div', { className: 'ledger-sub', textContent: 'Dissipated' }));
      for (const [k, v] of dissipated) rows.push(row(k, v));
      for (const [k, v] of reservoirs) rows.push(row(`Heat to ${k}`, v));
    }
    if (hydraulic.size) {
      rows.push(h('div', { className: 'ledger-sub', textContent: 'Hydraulic work (into fluid +, out of fluid −)' }));
      for (const [k, v] of hydraulic) rows.push(row(k, v));
    }
    rows.push(h('div', { className: 'ledger-total', dataset: { state } }, h('span', { textContent: 'Residual' }), h('span', { className: 'mono', textContent: `${si(L.residual, 'J')} · ${pct}` })));
    rows.push(h('div', {
      className: 'ledger-note',
      textContent: {
        ok: 'Within the 0.1 % budget.',
        warn: 'Over the 0.1 % budget. A shorter Δt or the trapezoidal integrator will tighten it.',
        crit: 'The integrator is adding or removing energy. Treat these results with care.',
        fail: 'The solver stopped.',
      }[state],
    }));
    $('ledger').replaceChildren(...rows);
  }

  // ---------------------------------------------------------------- rail

  private renderSceneSelect(): void {
    const sel = $<HTMLSelectElement>('scene-select');
    const value = this.current.kind === 'project' ? `project:${this.current.project.id}` : this.current.def.id;
    sel.replaceChildren(
      h('optgroup', { label: 'Examples' }, ...SCENES.map((s) => h('option', { value: s.id, textContent: s.name }))),
      h('optgroup', { label: 'My circuits' }, ...this.projects.map((p) => h('option', { value: `project:${p.id}`, textContent: p.name }))),
    );
    sel.value = value;
  }

  private renderTree(): void {
    const filter = $<HTMLInputElement>('filter').value.trim().toLowerCase();
    this.treeValues.clear();
    const groups: HTMLElement[] = [];
    for (const g of GROUPS) {
      const items = this.inst.components.filter((c) => c.group === g && (!filter || `${c.name} ${c.id}`.toLowerCase().includes(filter)));
      if (!items.length) continue;
      const head = h('div', { className: 'tree-head' },
        h('span', { className: 'swatch', style: `background:${GROUP_SWATCH[g]};${g === 'Couplings' ? 'border:1px solid var(--text-2)' : ''}` }),
        g, h('span', { className: 'count', textContent: String(items.length) }));
      const list = items.map((c) => {
        const val = h('span', { className: 'val', textContent: c.summary(this.sim) });
        this.treeValues.set(c.id, val);
        const domains = [...new Set(c.ports.map((p) => p.domain))];
        const btn = h('button', { className: 'tree-item', dataset: { id: c.id } }, c.name, ' ', h('span', { className: 'id', textContent: c.id }));
        if (domains.length > 1) {
          btn.append(h('span', { className: 'dots', style: 'margin-left:auto', ariaLabel: `Ports in ${domains.join(', ')} domains` }, ...domains.map((d) => h('span', { className: 'dot', style: `background:var(--d-${d})` }))));
          val.style.marginLeft = '8px';
        }
        btn.append(val);
        if (c.id === this.selection) btn.setAttribute('aria-current', 'true');
        btn.addEventListener('click', () => this.select(c.id));
        return btn;
      });
      groups.push(h('div', { className: 'tree-group' }, head, ...list));
    }
    if (!groups.length) groups.push(h('div', { className: 'muted', style: 'padding: 4px 10px', textContent: this.inst.components.length ? 'No components match.' : 'No parts yet. Add some from the Library.' }));
    $('tree').replaceChildren(...groups);
  }

  private renderProblems(): void {
    const list = this.compiled?.problems ?? [];
    const box = $('problems');
    box.hidden = !list.length;
    box.replaceChildren(h('div', { className: 'sec-label', textContent: `Checks · ${list.length}` }),
      ...list.map((p) => h('div', { className: `problem problem-${p.level}` }, p.text)));
  }

  private renderLibrary(): void {
    const groups: (Group | 'Reference')[] = ['Electrical', 'Control', 'Reference', 'Couplings', 'Rotational', 'Translational', 'Fluid', 'Thermal'];
    const root = $('library');
    root.replaceChildren(...groups.map((g) => h('div', { className: 'tree-group' },
      h('div', { className: 'tree-head' }, g),
      ...LIBRARY.filter((t) => t.group === g).map((t) => {
        const domains = [...new Set(t.ports.map((p) => p.domain))];
        const btn = h('button', { className: 'lib-item', draggable: true, title: `${t.blurb} Click to add, or drag into the view.` },
          h('span', { className: 'lib-name' }, t.name, h('span', { className: 'dots' }, ...domains.map((d) => h('span', { className: 'dot', style: `background:var(--d-${d})` })))),
          h('span', { className: 'lib-blurb', textContent: t.blurb }));
        btn.addEventListener('dragstart', (e) => { e.dataTransfer?.setData(PART_DRAG_MIME, t.type); if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy'; });
        btn.addEventListener('click', () => this.addPart(t.type));
        return btn;
      }))));
  }

  private renderSceneList(): void {
    const cur = this.current;
    const examples = SCENES.map((s) => {
      const b = h('button', { className: 'scene-btn' }, h('strong', { textContent: s.name }), h('span', { textContent: s.summary }));
      if (cur.kind === 'builtin' && cur.def.id === s.id) b.setAttribute('aria-current', 'true');
      b.addEventListener('click', () => { this.open(s.id); this.switchRailTab('model'); });
      return h('li', {}, b);
    });
    const mine = this.projects.map((p) => {
      const b = h('button', { className: 'scene-btn' }, h('strong', { textContent: p.name }), h('span', { textContent: `${p.parts.length} parts · ${p.wires.length} wires` }));
      if (cur.kind === 'project' && cur.project.id === p.id) b.setAttribute('aria-current', 'true');
      b.addEventListener('click', () => { this.open(`project:${p.id}`); this.switchRailTab('model'); });
      const confirming = this.confirmDelete === p.id;
      const del = h('button', {
        className: confirming ? 'btn-danger btn-small' : 'icon-btn', ariaLabel: `Delete ${p.name}`,
        textContent: confirming ? 'Delete' : '', innerHTML: confirming ? 'Delete' : '<svg width="13" height="13" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 4h8M5.5 4V2.5h3V4M4 4l.6 8h4.8L10 4" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
        onclick: () => {
          if (!confirming) { this.confirmDelete = p.id; this.renderSceneList(); return; }
          this.confirmDelete = null;
          this.projects = this.projects.filter((x) => x.id !== p.id);
          this.saveProjects();
          if (cur.kind === 'project' && cur.project.id === p.id) this.open(SCENES[0].id);
          else { this.renderSceneList(); this.renderSceneSelect(); }
          toast(`Deleted ${p.name}.`);
        },
      });
      return h('li', { className: 'scene-row' }, b, del);
    });
    $('scene-list').replaceChildren(
      h('li', { className: 'list-head', textContent: 'Examples · read-only' }), ...examples,
      h('li', { className: 'list-head', textContent: 'My circuits' }), ...mine,
    );
    $('btn-export').toggleAttribute('disabled', cur.kind !== 'project');
  }

  private renderNote(): void {
    if (this.current.kind === 'project') {
      const p = this.current.project;
      $('scene-note').replaceChildren(h('b', { textContent: p.name }), h('span', { textContent: `${p.parts.length} parts · ${p.wires.length} wires. Saved in this browser.` }),
        h('span', { textContent: this.editing ? 'Editing. Press Simulate to run it.' : 'Press Edit to change parts and wiring.' }));
      return;
    }
    const d = this.current.def;
    $('scene-note').replaceChildren(h('b', { textContent: d.name }), h('span', { textContent: d.summary }), ...(d.tip ? [h('span', { textContent: `Try this: ${d.tip}` })] : []));
  }

  private renderLegend(): void {
    const present = new Set<Domain>();
    for (const c of this.inst.components) for (const p of c.ports) present.add(p.domain);
    const sample: Record<Domain, string> = {
      electrical: '<line x1="0" y1="3" x2="22" y2="3" stroke="var(--d-electrical)" stroke-width="2.5"/>',
      rotational: '<line x1="1" y1="3" x2="21" y2="3" stroke="var(--d-rotational)" stroke-width="5" stroke-linecap="round"/>',
      thermal: '<line x1="0" y1="3" x2="22" y2="3" stroke="var(--d-thermal)" stroke-width="1.5" stroke-dasharray="2 4"/>',
      translational: '<line x1="1" y1="3" x2="21" y2="3" stroke="var(--d-translational)" stroke-width="4"/>',
      fluid: '<line x1="1" y1="3" x2="21" y2="3" stroke="var(--d-fluid)" stroke-width="6" stroke-opacity="0.75" stroke-linecap="round"/>',
    };
    $('legend').hidden = !present.size;
    $('legend').replaceChildren(...[...present].map((d) => {
      const s = h('span', { innerHTML: `<svg width="22" height="6" viewBox="0 0 22 6" aria-hidden="true">${sample[d]}</svg>` });
      s.append(DOMAIN_LABEL[d]);
      return s;
    }));
  }

  private switchRailTab(which: 'model' | 'library' | 'scenes'): void {
    for (const t of ['model', 'library', 'scenes'] as const) {
      $(`tab-${t}`).setAttribute('aria-selected', String(t === which));
      $(`panel-${t}`).hidden = t !== which;
    }
  }

  // ---------------------------------------------------------------- selection + inspector

  private select(id: string | null): void {
    this.selection = id;
    if (id) { this.selectedWire = null; this.viewport.setSelectedWire(null); }
    this.viewport.setSelection(id);
    for (const btn of $('tree').querySelectorAll<HTMLElement>('.tree-item')) {
      if (btn.dataset.id === id) btn.setAttribute('aria-current', 'true'); else btn.removeAttribute('aria-current');
    }
    this.renderInspector();
  }

  private renderInspector(): void {
    const root = $('inspector');
    this.live = [];
    const p = this.project;
    if (this.selectedWire && p) {
      const w = p.wires.find((x) => x.id === this.selectedWire);
      if (w) {
        const domain = this.compiled?.ports.get(`${w.a.part}.${w.a.port}`)?.domain ?? 'electrical';
        root.replaceChildren(h('div', { className: 'insp-head' },
          h('div', { className: 'insp-title' }, h('h2', { textContent: 'Wire' }), h('span', { className: 'mono muted', textContent: w.id })),
          h('div', { className: 'chips' }, h('span', { className: 'chip' }, h('span', { className: 'dot', style: `background:var(--d-${domain})` }), DOMAIN_LABEL[domain])),
          h('div', { className: 'mono', textContent: `${w.a.part}.${w.a.port} ↔ ${w.b.part}.${w.b.port}` })),
          h('section', { className: 'insp-sec' }, h('div', { className: 'actions' }, h('button', { className: 'btn-outline', textContent: 'Delete wire', onclick: () => this.deleteSelected() }))));
        return;
      }
    }
    const c = this.inst.components.find((x) => x.id === this.selection);
    if (!c) {
      root.replaceChildren(h('div', { className: 'insp-empty', textContent: this.editing
        ? 'Select a part or wire. Drag parts from the Library, then click a port and another port to connect them.'
        : 'Select a part in the view or the model tree to see its ports, parameters and live values.' }));
      return;
    }
    const part = p?.parts.find((x) => x.id === c.id);
    const domains = [...new Set(c.ports.map((q) => q.domain))];
    const head = h('div', { className: 'insp-head' },
      h('div', { className: 'insp-title' }, h('h2', { textContent: c.name }), h('span', { className: 'mono muted', textContent: c.id })),
      h('div', { className: 'insp-uri', textContent: c.type }),
      h('div', { className: 'chips' }, ...domains.map((d) => h('span', { className: 'chip' }, h('span', { className: 'dot', style: `background:var(--d-${d})` }), DOMAIN_LABEL[d]))),
      h('div', { className: 'fidelity' }, 'Fidelity', h('span', { className: 'tag', textContent: 'L0 · lumped' })));

    const ports = h('div', { className: 'ports' },
      h('span', { className: 'ph', textContent: 'Port' }), h('span', { className: 'ph', textContent: 'Effort' }), h('span', { className: 'ph', textContent: 'Flow in' }));
    const plotted = (port: Port, kind: 'effort' | 'flow') => this.plotted.some((x) => x.component === c.id && x.port === port.name && x.kind === kind);
    for (const port of c.ports) {
      const mk = (kind: 'effort' | 'flow') => h('button', {
        className: 'plot-btn', ariaPressed: String(plotted(port, kind)), title: `Plot ${c.id} ${port.name} ${kind}`,
        onclick: () => this.togglePlot({ component: c.id, port: port.name, kind }),
      });
      const e = mk('effort'), f = mk('flow');
      ports.append(h('span', { className: 'pn' }, h('span', { className: 'dot', style: `background:var(--d-${port.domain})` }), port.name), e, f);
      this.live.push({ update: () => { e.textContent = portEffortText(this.sim, port); f.textContent = portFlowText(c, port); } });
    }
    const sections: HTMLElement[] = [head, h('section', { className: 'insp-sec' }, h('div', { className: 'sec-label', textContent: 'Ports · live · click a value to plot it' }), ports)];
    if (c.params.length) {
      const sec = h('section', { className: 'insp-sec' }, h('div', { className: 'sec-label', textContent: 'Parameters' }));
      for (const prm of c.params) sec.append(this.paramRow(c, prm));
      sections.push(sec);
    }
    if (c.derived) {
      const sec = h('section', { className: 'insp-sec' }, h('div', { className: 'sec-label', textContent: 'Derived · live' }));
      const rows = c.derived(this.sim).map((r) => {
        const v = h('span', { className: 'mono', textContent: r.value });
        sec.append(h('div', { className: 'kv' }, h('span', { textContent: r.label }), v));
        return v;
      });
      this.live.push({ update: () => c.derived!(this.sim).forEach((r, i) => { if (rows[i]) rows[i].textContent = r.value; }) });
      sections.push(sec);
    }
    const acts: HTMLElement[] = (c.actions ?? []).map((a) => h('button', { className: 'btn-outline', textContent: a.label, onclick: () => { a.run(this.sim); this.updateUi(); } }));
    if (part && this.editing) {
      acts.push(h('button', { className: 'btn-outline', textContent: 'Rotate 90°', onclick: () => this.rotateSelected() }));
      acts.push(h('button', { className: 'btn-outline', textContent: 'Delete part', onclick: () => this.deleteSelected() }));
    }
    if (acts.length) sections.push(h('section', { className: 'insp-sec' }, h('div', { className: 'actions' }, ...acts)));
    root.replaceChildren(...sections);
    for (const l of this.live) l.update();
  }

  private paramRow(c: Component, prm: Param): HTMLElement {
    const id = `param-${c.id}-${prm.key}`;
    const input = h('input', { id, value: displayValue(prm), inputMode: 'decimal', autocomplete: 'off', spellcheck: false });
    const wrap = h('div', { className: 'param' },
      h('label', { for: id }, `${prm.label} `, h('span', { className: 'sym', textContent: prm.symbol })),
      h('span', { className: 'num' }, input, ...(prm.unit ? [h('span', { className: 'unit', textContent: prm.unit })] : [])),
      h('span', { className: 'sigma', textContent: prm.sigma !== undefined ? `± ${Number((prm.sigma / prm.scale).toPrecision(2))}` : '' }),
      h('span', { className: 'ev', dataset: { ev: prm.source }, textContent: prm.source }));
    const err = h('span', { className: 'err', role: 'alert' });
    const fail = (msg: string) => { wrap.dataset.invalid = 'true'; err.textContent = msg; wrap.append(err); };
    input.addEventListener('change', () => {
      const raw = Number(input.value.replace(',', '.').trim());
      err.remove();
      if (!Number.isFinite(raw)) return fail(`Enter a number${prm.unit ? ` in ${prm.unit}` : ''}.`);
      const v = (raw + prm.offset) * prm.scale;
      if (prm.min !== undefined && v < prm.min) return fail(`Must be at least ${Number((prm.min / prm.scale - prm.offset).toPrecision(3))}${prm.unit ? ` ${prm.unit}` : ''}.`);
      wrap.dataset.invalid = 'false';
      prm.value = v;
      input.value = displayValue(prm);
      const part = this.project?.parts.find((x) => x.id === c.id);
      if (part) { part.params[prm.key] = v; this.saveProjects(); }
      this.sim.markEvent();
      this.updateUi();
    });
    input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') input.blur(); });
    return wrap;
  }

  // ---------------------------------------------------------------- integrations

  private inputTargets() {
    const out: { id: string; label: string; apply(v: number): void }[] = [];
    for (const c of this.inst.components) {
      for (const prm of c.params) {
        out.push({
          id: `${c.id}.${prm.key}`, label: `${c.id} ${prm.label}${prm.unit ? ` (${prm.unit})` : ''}`,
          apply: (v) => { const next = (v + prm.offset) * prm.scale; if (next !== prm.value) { prm.value = next; this.sim.markEvent(); } },
        });
      }
      const st = (c as Component & { state?: { closed?: boolean } }).state;
      if (st && typeof st.closed === 'boolean') {
        out.push({ id: `${c.id}.closed`, label: `${c.id} switch closed (1) / open (0)`, apply: (v) => { const next = v > 0.5; if (next !== st.closed) { st.closed = next; this.sim.markEvent(); } } });
      }
    }
    return out;
  }

  private integrationStatus(s: { device: string; engine: boolean }): void {
    $('dot-hw').dataset.state = s.device;
    $('dot-eng').dataset.state = s.engine ? 'on' : 'off';
    $('integ-label').textContent = s.device === 'armed' ? 'Armed' : s.device !== 'off' || s.engine ? 'Connected' : 'Connect';
    $('btn-integrations').dataset.armed = String(s.device === 'armed');
  }

  // ---------------------------------------------------------------- chrome bindings

  private bindChrome(): void {
    $('btn-run').addEventListener('click', () => {
      if (this.editing) { this.setEditing(false); return; }
      this.setRunning(!this.running);
    });
    $('btn-step').addEventListener('click', () => this.stepFrame());
    $('btn-reset').addEventListener('click', () => this.reset());
    $<HTMLSelectElement>('scene-select').addEventListener('change', (e) => this.open((e.target as HTMLSelectElement).value));
    $<HTMLSelectElement>('sel-method').addEventListener('change', (e) => { this.sim.method = (e.target as HTMLSelectElement).value as 'be' | 'trap'; this.sim.markEvent(); });
    $<HTMLSelectElement>('sel-dt').addEventListener('change', (e) => { this.sim.h = Number((e.target as HTMLSelectElement).value); this.sim.markEvent(); this.carry = 0; });
    $('mode-simulate').addEventListener('click', () => this.setEditing(false));
    $('mode-edit').addEventListener('click', () => this.setEditing(true));
    for (const t of ['model', 'library', 'scenes'] as const) $(`tab-${t}`).addEventListener('click', () => this.switchRailTab(t));
    $('filter').addEventListener('input', () => this.renderTree());
    $('btn-new').addEventListener('click', () => this.newProject());
    $('btn-new-lib').addEventListener('click', () => this.newProject());
    $('btn-photo').addEventListener('click', () => this.openPhoto());
    $('btn-photo-lib').addEventListener('click', () => this.openPhoto());
    $('btn-export').addEventListener('click', () => {
      const p = this.project;
      if (p) download(`${p.name.replace(/[^\w-]+/g, '-').toLowerCase()}.ems.json`, JSON.stringify(p, null, 2), 'application/json');
    });
    $('btn-import').addEventListener('click', () => $('import-file').click());
    $<HTMLInputElement>('import-file').addEventListener('change', async (e) => {
      const input = e.target as HTMLInputElement;
      const file = input.files?.[0];
      input.value = '';
      if (!file) return;
      try {
        const p = JSON.parse(await file.text()) as unknown;
        if (!validProject(p)) throw new Error('That file is not a Motion Studio circuit.');
        p.id = `${p.id}-${Date.now().toString(36)}`;
        this.addProject(p, false);
        toast(`Imported ${p.name}.`);
      } catch (err) { toast((err as Error).message, 'error'); }
    });
    $('btn-scene-traces').addEventListener('click', () => { this.plotted = []; this.applyTraces(); this.renderInspector(); });
    $('btn-integrations').addEventListener('click', () => this.integrations.open());
    // The reference library is large text, so it loads on first use.
    $('btn-lab').addEventListener('click', () => {
      import('../lab/panel')
        .then(({ openLab }) => openLab({ openScene: (id) => this.open(id) }))
        .catch(() => toast('The Lab could not load. Check the dev server and try again.', 'error'));
    });
    $('dock-hw').addEventListener('click', () => dock('hw'));
    $('dock-scopes').addEventListener('click', () => dock('scopes'));
    $('hw-open').addEventListener('click', () => this.integrations.open('hardware'));
    const dock = (which: 'scopes' | 'hw') => {
      $('dock-scopes').setAttribute('aria-selected', String(which === 'scopes'));
      $('dock-hw').setAttribute('aria-selected', String(which === 'hw'));
      $('dock-panel-scopes').hidden = which !== 'scopes';
      $('dock-panel-hw').hidden = which !== 'hw';
    };
    for (const b of document.querySelectorAll<HTMLButtonElement>('[data-view]')) {
      b.addEventListener('click', () => {
        const v = b.dataset.view as CameraView;
        this.viewport.view(v);
        if (v !== 'frame') for (const o of document.querySelectorAll('[data-view]')) o.setAttribute('aria-pressed', String(o === b));
      });
    }
    for (const b of document.querySelectorAll<HTMLButtonElement>('[data-toggle]')) {
      b.addEventListener('click', () => {
        const on = b.getAttribute('aria-pressed') !== 'true';
        b.setAttribute('aria-pressed', String(on));
        this.viewport.setToggle(b.dataset.toggle as 'labels' | 'flow' | 'heat', on);
      });
    }
    $('btn-theme').addEventListener('click', () => {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      this.applyTheme(next);
      try { localStorage.setItem('ms-theme', next); } catch { /* storage unavailable */ }
      this.viewport.setPalette(this.palette());
      if (this.editing) this.viewport.setEditor(this.editorHandlers());
    });
    window.addEventListener('keydown', (ev) => {
      const t = ev.target as HTMLElement;
      if (ev.metaKey || ev.ctrlKey || ev.altKey || t.closest('input, select, textarea, dialog')) return;
      if (this.editing) {
        if (ev.key === 'Escape') { this.cancelWire(); this.select(null); }
        else if (ev.key === 'Delete' || ev.key === 'Backspace') { ev.preventDefault(); this.deleteSelected(); }
        else if (ev.key === 'r' || ev.key === 'R') this.rotateSelected();
        else if (ev.key === 'f' || ev.key === 'F') this.viewport.view('frame');
        return;
      }
      if (ev.key === ' ' && !t.closest('button')) { ev.preventDefault(); this.setRunning(!this.running); }
      else if (ev.key === '.') this.stepFrame();
      else if (ev.key === 'r' || ev.key === 'R') this.reset();
      else if (ev.key === 'f' || ev.key === 'F') this.viewport.view('frame');
    });
    window.addEventListener('hashchange', () => {
      const hash = decodeURIComponent(location.hash.slice(1));
      if (SCENES.some((s) => s.id === hash) || this.projects.some((p) => `project:${p.id}` === hash)) this.open(hash);
    });
  }

  private openPhoto(): void {
    openPhotoDialog((project, notes) => {
      this.addProject(project, false);
      this.setRunning(true);
      toast(notes.length ? `Twin created. ${notes.length} note${notes.length > 1 ? 's' : ''} in Checks.` : 'Twin created from the photo.');
      if (this.compiled) this.compiled.problems.unshift(...notes.map((text) => ({ level: 'info' as const, text })));
      this.renderProblems();
    });
  }

  // ---------------------------------------------------------------- theme

  private storedTheme(): 'dark' | 'light' {
    try {
      const t = localStorage.getItem('ms-theme');
      if (t === 'dark' || t === 'light') return t;
    } catch { /* storage unavailable */ }
    return 'dark';
  }

  private applyTheme(t: 'dark' | 'light'): void {
    document.documentElement.dataset.theme = t;
    $('btn-theme').setAttribute('aria-label', t === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
  }

  private palette(): Palette {
    return {
      ground: css('--ground'), grid: css('--grid'), gridMajor: css('--grid-major'),
      electrical: css('--d-electrical'), rotational: css('--d-rotational'), thermal: css('--d-thermal'),
      translational: css('--d-translational'), fluid: css('--d-fluid'), flowDot: css('--flow-dot'),
    };
  }

  private scopeColors(): ScopeColors {
    return {
      ground: css('--ground'), line: css('--line'), text2: css('--text-2'), text3: css('--text-3'), ink: css('--ink'),
      domain: { electrical: css('--d-electrical'), rotational: css('--d-rotational'), thermal: css('--d-thermal'), translational: css('--d-translational'), fluid: css('--d-fluid') },
      domainText: { electrical: css('--t-electrical'), rotational: css('--t-rotational'), thermal: css('--t-thermal'), translational: css('--t-translational'), fluid: css('--t-fluid') },
    };
  }
}

function storageCategory(el: Element): string {
  const d = el.domains[0];
  if (el instanceof Capacitance) return d === 'thermal' ? 'Thermal' : d === 'rotational' || d === 'translational' ? 'Kinetic' : 'Electric field';
  if (el instanceof Inductance) return d === 'rotational' || d === 'translational' ? 'Spring' : 'Magnetic';
  if (el.kind === 'storage' && d === 'rotational') return 'Potential (gravity)';
  return 'Other';
}
