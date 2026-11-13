import { type Domain, GROUND } from './core';
import { ambient, ModelBuilder, portFlow, thermalResistance } from './components';
import { type Built, PART_TYPES, portWorld } from './library';
import type { LabelSpec, SceneInstance, Trace, Vec3, VisualItem, WireSpec } from './scenes';
import { si } from './units';

export interface PartInstance {
  id: string;
  type: string;
  pos: [number, number];
  rot: number;
  /** SI values that override the part's defaults, by parameter key. */
  params: Record<string, number>;
}

export interface PortRef {
  part: string;
  port: string;
}

export interface Connection {
  id: string;
  a: PortRef;
  b: PortRef;
}

export interface Project {
  version: 1;
  id: string;
  name: string;
  parts: PartInstance[];
  wires: Connection[];
}

export interface Problem {
  level: 'warn' | 'info';
  text: string;
  part?: string;
}

export interface Compiled {
  scene: SceneInstance;
  problems: Problem[];
  /** Port positions for the editor, by `part.port`. */
  ports: Map<string, { pos: Vec3; domain: Domain }>;
}

const key = (r: PortRef) => `${r.part}.${r.port}`;

export function portDomain(p: Project, r: PortRef): Domain | undefined {
  const part = p.parts.find((x) => x.id === r.part);
  return part ? PART_TYPES.get(part.type)?.ports.find((d) => d.name === r.port)?.domain : undefined;
}

/** Why a new wire between two ports is not allowed, or null if it is. */
export function wireError(p: Project, a: PortRef, b: PortRef): string | null {
  if (a.part === b.part && a.port === b.port) return 'A port cannot connect to itself.';
  const da = portDomain(p, a), db = portDomain(p, b);
  if (!da || !db) return 'That port no longer exists.';
  if (da !== db) return `Cannot join a ${da} port to a ${db} port. Use a coupling part such as a motor.`;
  if (p.wires.some((w) => (key(w.a) === key(a) && key(w.b) === key(b)) || (key(w.a) === key(b) && key(w.b) === key(a)))) return 'Those ports are already connected.';
  return null;
}

export function nextId(p: Project, prefix: string): string {
  let n = 1;
  const taken = new Set(p.parts.map((x) => x.id));
  while (taken.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

/** Turn an editable project into a netlist, a 3D layout and the list of problems found on the way. */
export function compileProject(p: Project): Compiled {
  const problems: Problem[] = [];
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    let r = k;
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!;
    let c = k;
    while (c !== r) { const nx = parent.get(c)!; parent.set(c, r); c = nx; }
    return r;
  };
  const union = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };

  const parts = p.parts.filter((x) => {
    if (PART_TYPES.has(x.type)) return true;
    problems.push({ level: 'warn', text: `${x.id}: unknown part type "${x.type}" was skipped.`, part: x.id });
    return false;
  });
  for (const part of parts) for (const d of PART_TYPES.get(part.type)!.ports) parent.set(`${part.id}.${d.name}`, `${part.id}.${d.name}`);
  for (const w of p.wires) {
    if (!parent.has(key(w.a)) || !parent.has(key(w.b))) continue;
    if (portDomain(p, w.a) !== portDomain(p, w.b)) { problems.push({ level: 'warn', text: `Wire ${key(w.a)} – ${key(w.b)} joins two domains and was ignored.` }); continue; }
    union(key(w.a), key(w.b));
  }

  const grounded = new Set<string>();
  // Ground fixes electrical nets at 0 V; a fixed frame fixes translational nets at rest.
  for (const part of parts) {
    if (part.type === 'ground') grounded.add(find(`${part.id}.g`));
    if (part.type === 'anchor') grounded.add(find(`${part.id}.v`));
  }
  const degree = new Map<string, number>();
  for (const k of parent.keys()) degree.set(find(k), (degree.get(find(k)) ?? 0) + 1);

  const netName = (portKey: string, domain: Domain): string => {
    const root = find(portKey);
    if (grounded.has(root)) return 'gnd';
    return `${domain === 'thermal' ? 'th.' : domain === 'fluid' ? 'fl.' : 'n.'}${root}`;
  };

  const b = new ModelBuilder();
  const built = new Map<string, Built>();
  for (const part of parts) {
    const t = PART_TYPES.get(part.type)!;
    const nodes: Record<string, string> = {};
    for (const d of t.ports) nodes[d.name] = netName(`${part.id}.${d.name}`, d.domain);
    const res = t.build(b, part.id, nodes);
    for (const [k, v] of Object.entries(part.params)) {
      const prm = res.component.params.find((x) => x.key === k);
      if (prm && Number.isFinite(v)) prm.value = v;
    }
    built.set(part.id, res);
  }

  // A heat port with nowhere to send its heat would run away; give it still air at 22 °C.
  for (const part of parts) {
    const t = PART_TYPES.get(part.type)!;
    for (const d of t.ports) {
      if (d.domain !== 'thermal' || part.type === 'ambient') continue;
      const k = `${part.id}.${d.name}`;
      if ((degree.get(find(k)) ?? 0) > 1) continue;
      const id = `${part.id}.${d.name}~air`;
      thermalResistance(b, `${id}.R`, 'Still air', netName(k, 'thermal'), `th.${id}`, 10);
      ambient(b, `${id}.T`, 'Still air', `th.${id}`, 22);
      problems.push({ level: 'info', text: `${part.id} ${d.name} is not connected, so it cools to 22 °C air through 10 K/W.`, part: part.id });
    }
  }

  if (parts.some((x) => PART_TYPES.get(x.type)!.ports.some((d) => d.domain === 'electrical')) && !parts.some((x) => x.type === 'ground')) {
    problems.push({ level: 'warn', text: 'No Ground part. Add one so voltages have a 0 V reference.' });
  }
  // Ideal flow sources (current, force, torque) push into whatever their port meets; left open,
  // the node has nothing to push against and runs away.
  for (const part of parts) {
    if (!['currentsource', 'force', 'torque'].includes(part.type)) continue;
    const t = PART_TYPES.get(part.type)!;
    if (t.ports.some((d) => (degree.get(find(`${part.id}.${d.name}`)) ?? 0) < 2)) {
      problems.push({ level: 'warn', text: `${part.id}: an ideal ${t.name.toLowerCase()} needs a load. Connect its port${t.ports.length > 1 ? 's' : ''} or the result is meaningless.`, part: part.id });
    }
  }
  for (const part of parts) {
    const t = PART_TYPES.get(part.type)!;
    const open = t.ports.filter((d) => (d.domain === 'electrical' || d.domain === 'fluid') && (degree.get(find(`${part.id}.${d.name}`)) ?? 0) < 2);
    if (open.length && part.type !== 'ground' && part.type !== 'reservoir' && part.type !== 'fluidvolume') problems.push({ level: 'info', text: `${part.id}: ${open.map((d) => d.name).join(', ')} not connected.`, part: part.id });
  }

  // ------------------------------------------------------------- 3D layout
  const ports = new Map<string, { pos: Vec3; domain: Domain }>();
  const items: VisualItem[] = [];
  const labels: LabelSpec[] = [];
  for (const part of parts) {
    const t = PART_TYPES.get(part.type)!;
    const res = built.get(part.id)!;
    for (const d of t.ports) ports.set(`${part.id}.${d.name}`, { pos: portWorld(t, part.pos, part.rot, d.name), domain: d.domain });
    items.push({
      kind: t.visual, component: part.id, pos: [part.pos[0], t.elevation, part.pos[1]],
      opts: { ...(t.visualOpts ?? {}), rot: part.rot, scale: t.scale, ...(part.type === 'resistor' ? { ohms: res.component.params[0].value } : {}) },
      drive: res.drive,
    });
    const top = t.labelTop ?? t.elevation + (t.visual === 'flywheel' ? 5.4 : t.visual === 'motor' ? 2.6 : t.visual === 'battery' ? 5 : t.visual === 'bearing' ? 7.4 : 2.6 * t.scale);
    labels.push({
      component: part.id, anchor: [part.pos[0], top, part.pos[1]],
      lines: res.label ?? ((s) => [{ text: res.component.summary(s), domain: t.ports[0]?.domain }]),
    });
  }

  const wires: WireSpec[] = [];
  for (const w of p.wires) {
    const A = ports.get(key(w.a)), B = ports.get(key(w.b));
    if (!A || !B || A.domain !== B.domain) continue;
    const dist = Math.hypot(A.pos[0] - B.pos[0], A.pos[2] - B.pos[2]);
    const lift = A.domain === 'rotational' || A.domain === 'translational' ? 0 : A.domain === 'fluid' ? 0.4 + dist * 0.04 : 0.6 + dist * 0.06;
    const comp = built.get(w.a.part)!.component;
    const port = comp.ports.find((x) => x.name === w.a.port)!;
    const scale = A.domain === 'electrical' ? 0.5 : A.domain === 'thermal' ? 1 : A.domain === 'fluid' ? 0.2 : 0.02;
    wires.push({
      id: w.id, domain: A.domain, points: arcPoints(A.pos, B.pos, lift),
      flow: A.domain === 'rotational' || A.domain === 'translational' ? undefined : () => -portFlow(comp, port), scale,
    });
  }

  const nodeDomain = new Map(b.nodes.map((n) => [n.id, n.domain]));
  const traces: Trace[] = defaultTraces(parts.map((x) => built.get(x.id)!.component.id), b);
  const xs = parts.map((x) => x.pos[0]), zs = parts.map((x) => x.pos[1]);
  const cx = xs.length ? (Math.min(...xs) + Math.max(...xs)) / 2 : 0;
  const cz = zs.length ? (Math.min(...zs) + Math.max(...zs)) / 2 : 0;
  const span = xs.length ? Math.max(12, Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs)) : 20;

  return {
    problems,
    ports,
    scene: {
      nodes: b.nodes,
      elements: b.elements(),
      components: b.components,
      initial: (id) => {
        const d = nodeDomain.get(id);
        return d === 'thermal' ? 295.15 : d === 'fluid' ? 101325 : undefined;
      },
      traces,
      camera: { pos: [cx + span * 0.75, span * 0.85 + 4, cz + span * 1.25], target: [cx, 3, cz] },
      items, wires, labels,
    },
  };

  function defaultTraces(ids: string[], mb: ModelBuilder): Trace[] {
    const out: Trace[] = [];
    for (const id of ids) {
      const c = mb.components.find((x) => x.id === id)!;
      const pt = parts.find((x) => x.id === id)!.type;
      const offered = built.get(id)?.traces;
      if (offered?.length) { out.push(...offered.slice(0, 3 - out.length)); if (out.length >= 3) break; continue; }
      if (pt === 'dcmotor') {
        const m = c as typeof c & { current(): number; omega(s: unknown): number };
        out.push({ label: `${id} current`, unit: 'A', domain: 'electrical', get: () => m.current() });
        out.push({ label: `${id} speed`, unit: 'rpm', domain: 'rotational', get: (s) => (s.effort(c.ports[2].node) * 60) / (2 * Math.PI) });
      } else if (pt === 'led') out.push({ label: `${id} current`, unit: 'A', domain: 'electrical', get: () => c.elements[0].flows[0], min: 0 });
      else if (pt === 'capacitor') out.push({ label: `${id} voltage`, unit: 'V', domain: 'electrical', get: (s) => s.effort(c.ports[0].node) - s.effort(c.ports[1].node), hwKey: 'vc' });
      else if (pt === 'flywheel') out.push({ label: `${id} speed`, unit: 'rpm', domain: 'rotational', get: (s) => (s.effort(c.ports[0].node) * 60) / (2 * Math.PI), hwKey: 'rpm' });
      else if (pt === 'heatmass') out.push({ label: `${id} temperature`, unit: '°C', domain: 'thermal', get: (s) => s.effort(c.ports[0].node) - 273.15 });
      else if (pt === 'resistor' && out.length < 2) out.push({ label: `${id} current`, unit: 'A', domain: 'electrical', get: () => c.elements[0].flows[0] });
      if (out.length >= 3) break;
    }
    if (!out.length) {
      const first = mb.components.find((x) => x.ports.some((q) => q.node !== GROUND));
      if (first) {
        const q = first.ports.find((x) => x.node !== GROUND)!;
        const unit = { thermal: 'K', rotational: 'rad/s', translational: 'm/s', fluid: 'Pa', electrical: 'V' }[q.domain];
        out.push({ label: `${first.id} ${q.name}`, unit, domain: q.domain, get: (s) => s.effort(q.node) });
      }
    }
    return out;
  }
}

function arcPoints(a: Vec3, b: Vec3, lift: number, n = 8): Vec3[] {
  const pts: Vec3[] = [];
  for (let i = 0; i <= n; i++) {
    const s = i / n;
    pts.push([a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s + Math.sin(Math.PI * s) * lift, a[2] + (b[2] - a[2]) * s]);
  }
  return pts;
}

export function describe(p: Project): string {
  return `${p.parts.length} parts · ${p.wires.length} wires`;
}

export const STARTER: Project = {
  version: 1,
  id: 'my-circuit',
  name: 'My circuit',
  parts: [
    { id: 'B1', type: 'battery', pos: [-10, -2], rot: 0, params: { E: 9 } },
    { id: 'S1', type: 'switch', pos: [-4, 3], rot: 0, params: {} },
    { id: 'R1', type: 'resistor', pos: [1, 3], rot: 0, params: { R: 330 } },
    { id: 'D1', type: 'led', pos: [5, 0], rot: -Math.PI / 2, params: {} },
    { id: 'GND1', type: 'ground', pos: [1, -4], rot: 0, params: {} },
  ],
  wires: [
    { id: 'w1', a: { part: 'B1', port: 'p' }, b: { part: 'S1', port: 'a' } },
    { id: 'w2', a: { part: 'S1', port: 'b' }, b: { part: 'R1', port: 'a' } },
    { id: 'w3', a: { part: 'R1', port: 'b' }, b: { part: 'D1', port: 'anode' } },
    { id: 'w4', a: { part: 'D1', port: 'cathode' }, b: { part: 'GND1', port: 'g' } },
    { id: 'w5', a: { part: 'B1', port: 'n' }, b: { part: 'GND1', port: 'g' } },
  ],
};

export function formatParam(v: number, unit: string): string {
  return si(v, unit);
}
