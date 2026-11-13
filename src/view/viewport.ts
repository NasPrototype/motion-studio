import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import type { Domain, Simulator } from '../sim/core';
import type { Drive, LabelSpec, SceneInstance, Vec3, VisualItem, WireSpec } from '../sim/scenes';
import { buildModelExt } from './models-ext';

export interface Palette {
  ground: string;
  grid: string;
  gridMajor: string;
  electrical: string;
  rotational: string;
  thermal: string;
  translational: string;
  fluid: string;
  flowDot: string;
}

export type CameraView = 'perspective' | 'top' | 'front' | 'frame';

/** What the wiring editor needs from the 3D view. The app owns the project; the view reports gestures. */
export interface EditorHandlers {
  ports: Map<string, { pos: Vec3; domain: Domain }>;
  onPortClick(key: string): void;
  onWireClick(id: string): void;
  onEmptyClick(): void;
  onMove(part: string, x: number, z: number): void;
  onDrop(type: string, x: number, z: number): void;
}

export const PART_DRAG_MIME = 'application/x-ems-part';
const snap = (v: number) => Math.round(v * 2) / 2;

export interface Mats {
  metal: THREE.MeshStandardMaterial;
  darkMetal: THREE.MeshStandardMaterial;
  plastic: THREE.MeshStandardMaterial;
  board: THREE.MeshStandardMaterial;
  shaft: THREE.MeshStandardMaterial;
  wire: THREE.MeshStandardMaterial;
  heat: THREE.MeshBasicMaterial;
  dot: THREE.MeshBasicMaterial;
  thermalLine: THREE.LineDashedMaterial;
  rod: THREE.MeshStandardMaterial;
  pipe: THREE.MeshStandardMaterial;
  fluid: THREE.MeshStandardMaterial;
}

export interface FrameCtx {
  simDt: number;
  heatOn: boolean;
  angles: Map<string, number>;
}

export interface Model {
  item: VisualItem;
  group: THREE.Group;
  update(d: Drive, ctx: FrameCtx): void;
}

interface WireView {
  spec: WireSpec;
  curve: THREE.CatmullRomCurve3;
  length: number;
  dots?: THREE.InstancedMesh;
  phase: number;
}

interface CalloutView {
  spec: LabelSpec;
  el: HTMLDivElement;
  vals: HTMLDivElement;
  anchor: THREE.Vector3;
}

/** Rotation is drawn at up to 2 rev/s so fast shafts don't strobe; callouts show the true speed. */
const MAX_VISUAL_RATE = 4 * Math.PI;

const v3 = (p: Vec3) => new THREE.Vector3(p[0], p[1], p[2]);

export class Viewport {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(38, 1, 0.1, 500);
  private readonly controls: OrbitControls;
  private readonly mats: Mats;
  private content = new THREE.Group();
  private grid?: THREE.GridHelper;
  private readonly groundMat = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0 });
  private readonly selBox: THREE.LineSegments;
  private models: Model[] = [];
  private wires: WireView[] = [];
  private callouts: CalloutView[] = [];
  private pickables: THREE.Object3D[] = [];
  private byComponent = new Map<string, THREE.Object3D[]>();
  private angles = new Map<string, number>();
  private selection: string | null = null;
  private toggles = { labels: true, flow: true, heat: true };
  private home = { pos: new THREE.Vector3(), target: new THREE.Vector3() };
  private tween?: { from: THREE.Vector3; to: THREE.Vector3; tf: THREE.Vector3; tt: THREE.Vector3; t: number };

  private readonly raycaster = new THREE.Raycaster();
  private down?: { x: number; y: number };
  private labelTick = 0;
  private editor: EditorHandlers | null = null;
  private readonly portGroup = new THREE.Group();
  private wireMeshes: THREE.Object3D[] = [];
  private pendingFrom: string | null = null;
  private selectedWire: string | null = null;
  private readonly band: THREE.Line;
  private pointerNdc = new THREE.Vector2(9, 9);
  private drag?: { part: string; group: THREE.Object3D; offset: THREE.Vector3; startX: number; startZ: number; moved: boolean };
  private readonly floor = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private readonly selWireMat = new THREE.MeshBasicMaterial({ color: '#E3EBF3' });
  private readonly shaftWireMat = new THREE.MeshStandardMaterial({ metalness: 0.35, roughness: 0.4 });
  private readonly reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  constructor(
    private readonly container: HTMLElement,
    private readonly calloutLayer: HTMLElement,
    palette: Palette,
    private readonly onPick: (id: string | null) => void,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    container.prepend(this.renderer.domElement);
    this.renderer.domElement.setAttribute('aria-label', '3D view of the model. Click a part to inspect it.');
    this.renderer.domElement.setAttribute('role', 'img');

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 6;
    this.controls.maxDistance = 140;
    this.controls.maxPolarAngle = Math.PI * 0.495;

    this.mats = {
      metal: new THREE.MeshStandardMaterial({ color: '#9AA6B4', metalness: 0.75, roughness: 0.32 }),
      darkMetal: new THREE.MeshStandardMaterial({ color: '#4E5A68', metalness: 0.6, roughness: 0.45 }),
      plastic: new THREE.MeshStandardMaterial({ color: '#28323D', metalness: 0.05, roughness: 0.7 }),
      board: new THREE.MeshStandardMaterial({ color: '#E7E9E2', roughness: 0.9 }),
      shaft: new THREE.MeshStandardMaterial({ metalness: 0.35, roughness: 0.4 }),
      wire: new THREE.MeshStandardMaterial({ metalness: 0.1, roughness: 0.5 }),
      heat: new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.6, depthWrite: false }),
      dot: new THREE.MeshBasicMaterial({}),
      thermalLine: new THREE.LineDashedMaterial({ dashSize: 0.45, gapSize: 0.45 }),
      rod: new THREE.MeshStandardMaterial({ metalness: 0.55, roughness: 0.35 }),
      pipe: new THREE.MeshStandardMaterial({ metalness: 0.2, roughness: 0.35, transparent: true, opacity: 0.85 }),
      fluid: new THREE.MeshStandardMaterial({ metalness: 0.1, roughness: 0.3, transparent: true, opacity: 0.75 }),
    };

    const hemi = new THREE.HemisphereLight('#dfe9f5', '#2a3542', 1.1);
    const sun = new THREE.DirectionalLight('#ffffff', 2.2);
    sun.position.set(-18, 34, 22);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -34; sun.shadow.camera.right = 34;
    sun.shadow.camera.top = 34; sun.shadow.camera.bottom = -34;
    sun.shadow.bias = -0.0004;
    const fill = new THREE.DirectionalLight('#9fc0ff', 0.5);
    fill.position.set(20, 10, -16);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), this.groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(hemi, sun, fill, ground, this.content);

    const edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
    this.selBox = new THREE.LineSegments(edges, new THREE.LineDashedMaterial({ color: '#E3EBF3', dashSize: 0.06, gapSize: 0.045, depthTest: false, transparent: true }));
    this.selBox.computeLineDistances();
    this.selBox.renderOrder = 10;
    this.selBox.visible = false;
    this.scene.add(this.selBox);

    this.band = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineDashedMaterial({ color: '#E3EBF3', dashSize: 0.4, gapSize: 0.25, depthTest: false, transparent: true }));
    this.band.renderOrder = 11;
    this.band.visible = false;
    this.scene.add(this.portGroup, this.band);

    this.setPalette(palette);
    this.bindPointer();
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
  }

  // ------------------------------------------------------------------ public

  load(inst: SceneInstance, opts: { keepCamera?: boolean } = {}): void {
    this.content.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
    });
    this.scene.remove(this.content);
    this.content = new THREE.Group();
    this.scene.add(this.content);
    this.models = [];
    this.wires = [];
    this.wireMeshes = [];
    this.pickables = [];
    this.byComponent.clear();
    if (!opts.keepCamera) this.angles.clear();
    this.calloutLayer.replaceChildren();
    this.callouts = [];

    for (const item of inst.items) {
      const model = buildModel(item, this.mats);
      model.group.position.set(...item.pos);
      model.group.rotation.y = Number(item.opts?.rot ?? 0);
      model.group.scale.setScalar(Number(item.opts?.scale ?? 1));
      model.group.name = item.component ?? item.kind;
      this.content.add(model.group);
      this.models.push(model);
      model.group.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) {
          o.castShadow = true;
          o.receiveShadow = true;
          const cid = (o.userData.cid as string | undefined) ?? item.component;
          if (cid) {
            o.userData.cid = cid;
            this.pickables.push(o);
            const list = this.byComponent.get(cid) ?? [];
            list.push(o);
            this.byComponent.set(cid, list);
          }
        }
      });
    }
    for (const spec of inst.wires) this.wires.push(this.buildWire(spec));
    for (const spec of inst.labels) {
      const comp = inst.components.find((c) => c.id === spec.component);
      const el = document.createElement('div');
      el.className = 'callout';
      const title = document.createElement('b');
      title.textContent = `${spec.component} · ${comp?.name ?? ''}`;
      const vals = document.createElement('div');
      vals.className = 'vals';
      el.append(title, vals);
      this.calloutLayer.append(el);
      this.callouts.push({ spec, el, vals, anchor: v3(spec.anchor) });
    }
    this.home.pos.set(...inst.camera.pos);
    this.home.target.set(...inst.camera.target);
    if (!opts.keepCamera) {
      this.camera.position.copy(this.home.pos);
      this.controls.target.copy(this.home.target);
    }
    this.controls.update();
    this.setSelectedWire(this.selectedWire);
  }

  /** Turn the wiring editor on (with the current port positions) or off. */
  setEditor(handlers: EditorHandlers | null): void {
    this.editor = handlers;
    for (const m of this.portGroup.children) (m as THREE.Mesh).geometry.dispose();
    this.portGroup.clear();
    if (!handlers) { this.setPendingWire(null); return; }
    const geo = new THREE.SphereGeometry(0.42, 18, 12);
    for (const [k, p] of handlers.ports) {
      const mat = new THREE.MeshBasicMaterial({ color: this.domainColor(p.domain), depthTest: false, transparent: true, opacity: 0.95 });
      const m = new THREE.Mesh(geo, mat);
      m.position.set(...p.pos);
      m.renderOrder = 12;
      m.userData.port = k;
      m.userData.part = k.split('.')[0];
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.6, 24), new THREE.MeshBasicMaterial({ color: '#0A1622', depthTest: false, transparent: true, opacity: 0.85, side: THREE.DoubleSide }));
      ring.renderOrder = 11;
      ring.userData.ring = true;
      m.add(ring);
      this.portGroup.add(m);
    }
    this.setPendingWire(this.pendingFrom);
  }

  /** Show a rubber-band line from a port to the pointer while a wire is being drawn. */
  setPendingWire(from: string | null): void {
    this.pendingFrom = from;
    this.band.visible = !!from && !!this.editor?.ports.get(from);
    for (const m of this.portGroup.children) m.scale.setScalar(m.userData.port === from ? 1.6 : 1);
  }

  setSelectedWire(id: string | null): void {
    this.selectedWire = id;
    for (const w of this.wireMeshes) {
      const mesh = w as THREE.Mesh;
      mesh.material = mesh.userData.wire === id ? this.selWireMat : (mesh.userData.baseMat as THREE.Material);
    }
  }

  /** The current 3D content as a binary glTF, with one node per part named by its id. */
  async exportGLB(): Promise<ArrayBuffer> {
    const exporter = new GLTFExporter();
    const out = await exporter.parseAsync(this.content, { binary: true, onlyVisible: true });
    return out as ArrayBuffer;
  }

  private domainColor(d: Domain): string {
    return this.palColors[d];
  }

  private palColors: Record<Domain, string> = { electrical: '#74A6FF', rotational: '#6DC48A', thermal: '#FF7D69', translational: '#B79CFF', fluid: '#3CC8C8' };

  private groupOf(part: string): THREE.Object3D | undefined {
    return this.models.find((m) => m.item.component === part)?.group;
  }

  private groundPoint(): THREE.Vector3 | null {
    const p = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(this.floor, p);
  }

  setPalette(p: Palette): void {

    this.scene.background = new THREE.Color(p.ground);
    this.scene.fog = new THREE.Fog(p.ground, 70, 170);
    this.groundMat.color.set(p.ground);
    this.mats.shaft.color.set(p.rotational);
    this.mats.wire.color.set(p.electrical);
    this.mats.heat.color.set(p.thermal);
    this.mats.thermalLine.color.set(p.thermal);
    this.mats.dot.color.set(p.flowDot);
    this.shaftWireMat.color.set(p.rotational);
    this.mats.rod.color.set(p.translational);
    this.mats.pipe.color.set(p.fluid);
    this.mats.fluid.color.set(p.fluid);
    this.palColors = { electrical: p.electrical, rotational: p.rotational, thermal: p.thermal, translational: p.translational, fluid: p.fluid };
    const ink = getComputedStyle(document.documentElement).getPropertyValue('--ink').trim() || '#E3EBF3';
    this.selWireMat.color.set(ink);
    if (this.band) (this.band.material as THREE.LineDashedMaterial).color.set(ink);
    if (this.grid) { this.scene.remove(this.grid); this.grid.geometry.dispose(); }
    this.grid = new THREE.GridHelper(80, 40, p.gridMajor, p.grid);
    this.grid.position.y = 0.01;
    this.scene.add(this.grid);
    (this.selBox.material as THREE.LineDashedMaterial).color.set(getComputedStyle(document.documentElement).getPropertyValue('--ink').trim() || '#E3EBF3');
  }

  setSelection(id: string | null): void {
    this.selection = id;
    for (const c of this.callouts) c.el.dataset.selected = String(c.spec.component === id);
  }

  setToggle(key: 'labels' | 'flow' | 'heat', on: boolean): void {
    this.toggles[key] = on;
    this.calloutLayer.hidden = !this.toggles.labels;
  }

  view(kind: CameraView): void {
    const target = this.controls.target.clone();
    const dist = this.camera.position.distanceTo(target);
    let pos: THREE.Vector3;
    let tgt = target;
    if (kind === 'perspective') { pos = this.home.pos.clone(); tgt = this.home.target.clone(); }
    else if (kind === 'top') pos = target.clone().add(new THREE.Vector3(0, dist, 0.01));
    else if (kind === 'front') pos = target.clone().add(new THREE.Vector3(0, dist * 0.18, dist));
    else {
      const box = this.selectionBox();
      if (!box) return;
      tgt = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3()).length();
      const dir = this.camera.position.clone().sub(this.controls.target).normalize();
      pos = tgt.clone().add(dir.multiplyScalar(Math.max(size * 2.4, 8)));
    }
    if (this.reducedMotion) {
      this.camera.position.copy(pos);
      this.controls.target.copy(tgt);
      return;
    }
    this.tween = { from: this.camera.position.clone(), to: pos, tf: this.controls.target.clone(), tt: tgt, t: 0 };
  }

  /** Advance animations by `simDt` of simulated time and render. */
  frame(sim: Simulator, simDt: number, wallDt: number): void {
    if (this.tween) {
      this.tween.t = Math.min(1, this.tween.t + wallDt / 0.45);
      const s = 1 - Math.pow(1 - this.tween.t, 3);
      this.camera.position.lerpVectors(this.tween.from, this.tween.to, s);
      this.controls.target.lerpVectors(this.tween.tf, this.tween.tt, s);
      if (this.tween.t >= 1) this.tween = undefined;
    }
    this.controls.update();

    if (this.band.visible && this.pendingFrom) {
      const from = this.editor?.ports.get(this.pendingFrom);
      this.raycaster.setFromCamera(this.pointerNdc, this.camera);
      const to = this.groundPoint();
      if (from && to) {
        const start = v3(from.pos);
        to.y = Math.max(0.3, start.y * 0.5);
        this.band.geometry.setFromPoints([start, to]);
        this.band.computeLineDistances();
      }
    }

    const ctx: FrameCtx = { simDt, heatOn: this.toggles.heat, angles: this.angles };
    for (const m of this.models) m.update(m.item.drive?.(sim) ?? {}, ctx);
    for (const w of this.wires) this.updateWire(w, sim, wallDt);

    const box = this.selectionBox();
    if (box) {
      const size = box.getSize(new THREE.Vector3()).addScalar(0.5);
      this.selBox.scale.copy(size);
      box.getCenter(this.selBox.position);
      this.selBox.visible = true;
    } else this.selBox.visible = false;

    this.labelTick += wallDt;
    const refreshText = this.labelTick > 0.1;
    if (refreshText) this.labelTick = 0;
    if (this.toggles.labels) this.placeCallouts(sim, refreshText);

    this.renderer.render(this.scene, this.camera);
  }

  // ------------------------------------------------------------------ internals

  private resize(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private selectionBox(): THREE.Box3 | null {
    if (!this.selection) return null;
    const objs = this.byComponent.get(this.selection);
    if (!objs?.length) return null;
    const box = new THREE.Box3();
    for (const o of objs) box.expandByObject(o);
    return box.isEmpty() ? null : box;
  }

  private bindPointer(): void {
    const el = this.renderer.domElement;
    const cast = (ev: { clientX: number; clientY: number }) => {
      lastClient = { x: ev.clientX, y: ev.clientY };
      const r = el.getBoundingClientRect();
      this.pointerNdc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
      this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    };
    const first = (objs: THREE.Object3D[], key: string): string | null =>
      (this.raycaster.intersectObjects(objs, false)[0]?.object.userData[key] as string | undefined) ?? null;
    let lastClient = { x: 0, y: 0 };
    const hitPort = () => (this.editor ? first(this.portGroup.children, 'port') ?? this.portNearScreen(lastClient.x, lastClient.y, 14) : null);
    const hitWire = () => (this.editor ? first(this.wireMeshes, 'wire') : null);
    const hitPart = () => first(this.pickables, 'cid');

    el.addEventListener('pointerdown', (ev) => {
      this.down = { x: ev.clientX, y: ev.clientY };
      if (!this.editor || ev.button !== 0) return;
      cast(ev);
      if (hitPort()) return;
      const part = hitPart();
      const g = part ? this.groupOf(part) : undefined;
      const gp = this.groundPoint();
      if (part && g && gp) {
        this.drag = { part, group: g, offset: new THREE.Vector3(g.position.x - gp.x, 0, g.position.z - gp.z), startX: g.position.x, startZ: g.position.z, moved: false };
        this.controls.enabled = false;
        el.setPointerCapture(ev.pointerId);
      }
    });

    el.addEventListener('pointermove', (ev) => {
      cast(ev);
      if (this.drag) {
        const gp = this.groundPoint();
        if (!gp) return;
        const d = this.drag;
        const x = snap(gp.x + d.offset.x), z = snap(gp.z + d.offset.z);
        const dx = x - d.group.position.x, dz = z - d.group.position.z;
        if (dx === 0 && dz === 0) return;
        d.group.position.x = x;
        d.group.position.z = z;
        d.moved = x !== d.startX || z !== d.startZ;
        for (const m of this.portGroup.children) if (m.userData.part === d.part) { m.position.x += dx; m.position.z += dz; }
        for (const c of this.callouts) if (c.spec.component === d.part) { c.anchor.x += dx; c.anchor.z += dz; }
        return;
      }
      if (this.down) return;
      if (hitPort()) el.style.cursor = 'crosshair';
      else if (hitWire()) el.style.cursor = 'pointer';
      else if (hitPart()) el.style.cursor = this.editor ? 'move' : 'pointer';
      else el.style.cursor = this.pendingFrom ? 'crosshair' : 'grab';
    });

    el.addEventListener('pointerup', (ev) => {
      const moved = this.down ? Math.hypot(ev.clientX - this.down.x, ev.clientY - this.down.y) : 99;
      this.down = undefined;
      if (this.drag) {
        const d = this.drag;
        this.drag = undefined;
        this.controls.enabled = true;
        if (d.moved) { this.editor?.onMove(d.part, d.group.position.x, d.group.position.z); return; }
      }
      if (moved >= 5 || ev.button !== 0) return;
      cast(ev);
      if (this.editor) {
        const port = hitPort();
        if (port) { this.editor.onPortClick(port); return; }
        if (this.pendingFrom) {
          // Finishing a wire: a click anywhere on a part picks its nearest compatible port.
          const part = hitPart();
          const near = part ? this.nearestPort(part, ev.clientX, ev.clientY) : null;
          if (near) { this.editor.onPortClick(near); return; }
        }
        const wire = hitWire();
        if (wire) { this.editor.onWireClick(wire); return; }
      }
      const part = hitPart();
      this.onPick(part);
      if (this.editor && !part) this.editor.onEmptyClick();
    });

    this.container.addEventListener('dragover', (ev) => {
      if (!this.editor || !ev.dataTransfer?.types.includes(PART_DRAG_MIME)) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'copy';
    });
    this.container.addEventListener('drop', (ev) => {
      const type = ev.dataTransfer?.getData(PART_DRAG_MIME);
      if (!type || !this.editor) return;
      ev.preventDefault();
      cast(ev);
      const gp = this.groundPoint();
      if (gp) this.editor.onDrop(type, snap(gp.x), snap(gp.z));
    });
  }

  /** The port marker drawn nearest to a screen point, if within `maxPx`. Markers are small at a distance. */
  private portNearScreen(cx: number, cy: number, maxPx: number): string | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    const p = new THREE.Vector3();
    let best: string | null = null;
    let bestD = maxPx;
    for (const m of this.portGroup.children) {
      p.copy(m.position).project(this.camera);
      if (p.z > 1) continue;
      const d = Math.hypot(r.left + ((p.x + 1) / 2) * r.width - cx, r.top + ((1 - p.y) / 2) * r.height - cy);
      if (d < bestD) { bestD = d; best = m.userData.port as string; }
    }
    return best;
  }

  private nearestPort(part: string, cx: number, cy: number): string | null {
    const from = this.pendingFrom ? this.editor?.ports.get(this.pendingFrom) : undefined;
    if (!from) return null;
    const r = this.renderer.domElement.getBoundingClientRect();
    let best: string | null = null;
    let bestD = Infinity;
    const p = new THREE.Vector3();
    for (const m of this.portGroup.children) {
      const key = m.userData.port as string;
      if (m.userData.part !== part || key === this.pendingFrom || this.editor?.ports.get(key)?.domain !== from.domain) continue;
      p.copy(m.position).project(this.camera);
      const d = Math.hypot(r.left + ((p.x + 1) / 2) * r.width - cx, r.top + ((1 - p.y) / 2) * r.height - cy);
      if (d < bestD) { bestD = d; best = key; }
    }
    return best;
  }

  /** Ground-plane point under the viewport centre, for parts added with a click instead of a drag. */
  centerPoint(): [number, number] {
    this.raycaster.setFromCamera(new THREE.Vector2(0, 0), this.camera);
    const p = this.groundPoint();
    return p ? [snap(p.x), snap(p.z)] : [0, 0];
  }

  private buildWire(spec: WireSpec): WireView {
    const curve = new THREE.CatmullRomCurve3(spec.points.map(v3), false, 'centripetal');
    const length = curve.getLength();
    const view: WireView = { spec, curve, length, phase: Math.random() };
    if (spec.domain === 'thermal') {
      const geo = new THREE.BufferGeometry().setFromPoints(curve.getPoints(48));
      const line = new THREE.Line(geo, this.mats.thermalLine);
      line.computeLineDistances();
      this.content.add(line);
      if (spec.id) {
        // An invisible tube makes the dashed line clickable in the editor.
        const hit = new THREE.Mesh(new THREE.TubeGeometry(curve, 32, 0.25, 6, false), new THREE.MeshBasicMaterial({ visible: false }));
        hit.userData.wire = spec.id;
        hit.userData.baseMat = hit.material;
        this.wireMeshes.push(hit);
        this.content.add(hit);
      }
      return view;
    }
    const shaft = spec.domain === 'rotational';
    const rod = spec.domain === 'translational';
    const pipe = spec.domain === 'fluid';
    const baseMat = shaft ? this.shaftWireMat : rod ? this.mats.rod : pipe ? this.mats.pipe : this.mats.wire;
    const radius = shaft ? 0.22 : rod ? 0.16 : pipe ? 0.3 : 0.085;
    const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, Math.max(24, Math.round(length * 6)), radius, shaft || pipe ? 14 : 8, false), baseMat);
    tube.castShadow = true;
    tube.name = spec.id ? `wire-${spec.id}` : 'wire';
    if (spec.id) {
      tube.userData.wire = spec.id;
      tube.userData.baseMat = baseMat;
      this.wireMeshes.push(tube);
    }
    this.content.add(tube);
    if (spec.flow) {
      const count = Math.max(2, Math.floor(length / 1.3));
      const dots = new THREE.InstancedMesh(new THREE.SphereGeometry(pipe ? 0.2 : 0.14, 10, 8), this.mats.dot, count);
      dots.frustumCulled = false;
      this.content.add(dots);
      view.dots = dots;
    }
    return view;
  }

  private updateWire(w: WireView, sim: Simulator, wallDt: number): void {
    if (!w.dots) return;
    const f = w.spec.flow?.(sim) ?? 0;
    const scale = w.spec.scale ?? 1;
    const show = this.toggles.flow && Math.abs(f) > scale * 2e-3;
    w.dots.visible = show;
    if (!show) return;
    const speed = Math.sign(f) * 5 * Math.tanh(Math.abs(f) / scale); // world units per second
    w.phase = (w.phase + (speed * wallDt) / w.length) % 1;
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    for (let i = 0; i < w.dots.count; i++) {
      let u = (i / w.dots.count + w.phase) % 1;
      if (u < 0) u += 1;
      w.curve.getPointAt(u, p);
      m.makeTranslation(p.x, p.y, p.z);
      w.dots.setMatrixAt(i, m);
    }
    w.dots.instanceMatrix.needsUpdate = true;
  }

  private placeCallouts(sim: Simulator, refreshText: boolean): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    const p = new THREE.Vector3();
    for (const c of this.callouts) {
      p.copy(c.anchor).project(this.camera);
      const visible = p.z < 1 && Math.abs(p.x) < 1.15 && Math.abs(p.y) < 1.15;
      c.el.hidden = !visible;
      if (!visible) continue;
      const x = ((p.x + 1) / 2) * w;
      const y = ((1 - p.y) / 2) * h;
      c.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`;
      if (refreshText) {
        const lines = c.spec.lines(sim);
        c.vals.replaceChildren(...lines.map((l) => {
          const s = document.createElement('span');
          s.textContent = l.text;
          if (l.domain) s.className = `d-${l.domain}`;
          return s;
        }));
      }
    }
  }
}

// ======================================================================== models

function mesh(geo: THREE.BufferGeometry, mat: THREE.Material): THREE.Mesh {
  return new THREE.Mesh(geo, mat);
}

function alongX(m: THREE.Mesh): THREE.Mesh {
  m.rotation.z = Math.PI / 2;
  return m;
}

function textTexture(lines: string[], w: number, h: number, bg: string, fg: string, size: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const g = canvas.getContext('2d')!;
  g.fillStyle = bg; g.fillRect(0, 0, w, h);
  g.fillStyle = fg;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  lines.forEach((t, i) => {
    g.font = `${i === 0 ? 600 : 500} ${i === 0 ? size : size * 0.6}px "IBM Plex Mono", ui-monospace, monospace`;
    g.fillText(t, w / 2, h / 2 + (i - (lines.length - 1) / 2) * size * 0.95);
  });
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function gearGeometry(teeth: number, pitchR: number, module: number, thickness: number): THREE.ExtrudeGeometry {
  const ra = pitchR + module;
  const rr = pitchR - 1.25 * module;
  const step = (Math.PI * 2) / teeth;
  const shape = new THREE.Shape();
  for (let i = 0; i < teeth; i++) {
    const a = i * step;
    const pts: [number, number][] = [[rr, a], [ra, a + step * 0.2], [ra, a + step * 0.45], [rr, a + step * 0.65]];
    pts.forEach(([r, t], j) => {
      const x = r * Math.cos(t), y = r * Math.sin(t);
      if (i === 0 && j === 0) shape.moveTo(x, y); else shape.lineTo(x, y);
    });
  }
  shape.closePath();
  const hole = new THREE.Path();
  hole.absarc(0, 0, Math.max(0.2, pitchR * 0.14), 0, Math.PI * 2, true);
  shape.holes.push(hole);
  const geo = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false, curveSegments: 4 });
  geo.translate(0, 0, -thickness / 2);
  geo.rotateY(Math.PI / 2); // axis along X
  return geo;
}

function spin(ctx: FrameCtx, id: string, omega: number): number {
  const rate = Math.sign(omega) * Math.min(Math.abs(omega), MAX_VISUAL_RATE);
  const a = (ctx.angles.get(id) ?? 0) + rate * ctx.simDt;
  ctx.angles.set(id, a);
  return a;
}

const BAND_COLORS = ['#111111', '#6B3E1F', '#C0392B', '#D97A2B', '#E2C02B', '#2E9E5B', '#2D5BB5', '#7A4BB0', '#8A8A8A', '#EEEEEE'];

function resistorBands(ohms: number): string[] {
  const exp = Math.max(0, Math.floor(Math.log10(ohms)) - 1);
  const sig = Math.round(ohms / 10 ** exp);
  return [BAND_COLORS[Math.floor(sig / 10) % 10], BAND_COLORS[sig % 10], BAND_COLORS[exp % 10], '#C9A227'];
}

function buildModel(item: VisualItem, M: Mats): Model {
  const g = new THREE.Group();
  const noop = () => {};
  const o = item.opts ?? {};

  switch (item.kind) {
    case 'battery': {
      const body = mesh(new THREE.BoxGeometry(6, 3.6, 3), M.plastic);
      body.position.y = 1.8;
      const face = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 2.2), new THREE.MeshStandardMaterial({ map: textTexture([String(o.label ?? ''), item.component ?? ''], 256, 134, '#1C252F', '#E3EBF3', 64), roughness: 0.8 }));
      face.position.set(0, 1.8, 1.51);
      const pos = mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.36, 20), new THREE.MeshStandardMaterial({ color: '#C0392B', roughness: 0.5 }));
      pos.position.set(-1.2, 3.75, 0);
      const neg = mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.36, 20), M.darkMetal);
      neg.position.set(1.2, 3.75, 0);
      g.add(body, face, pos, neg);
      return { item, group: g, update: noop };
    }
    case 'switch': {
      const base = mesh(new THREE.BoxGeometry(2.6, 0.8, 1.6), M.plastic);
      base.position.y = 0.4;
      const c1 = mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.2, 14), M.metal); c1.position.set(-1.1, 0.85, 0);
      const c2 = c1.clone(); c2.position.x = 1.1;
      const pivot = new THREE.Group();
      pivot.position.set(0, 0.8, 0);
      const lever = mesh(new THREE.CylinderGeometry(0.11, 0.11, 1.7, 14), M.metal);
      lever.position.y = 0.85;
      const knob = mesh(new THREE.SphereGeometry(0.22, 16, 12), M.metal);
      knob.position.y = 1.7;
      pivot.add(lever, knob);
      g.add(base, c1, c2, pivot);
      let a = -0.55;
      return {
        item, group: g,
        update: (d) => {
          const target = d.closed ? -0.55 : 0.55;
          a += (target - a) * 0.25;
          pivot.rotation.z = a;
        },
      };
    }
    case 'motor': {
      const can = alongX(mesh(new THREE.CylinderGeometry(1.6, 1.6, 4, 48), M.metal));
      const rear = alongX(mesh(new THREE.CylinderGeometry(1.62, 1.62, 0.5, 48), M.darkMetal)); rear.position.x = -2.1;
      const boss = alongX(mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.35, 24), M.darkMetal)); boss.position.x = 2.15;
      const bracket = mesh(new THREE.BoxGeometry(3.2, 4.4, 2.8), M.plastic); bracket.position.y = -3.8;
      const tabA = mesh(new THREE.BoxGeometry(0.3, 0.5, 0.12), M.metal); tabA.position.set(-2.4, 0.7, 0.7);
      const tabB = tabA.clone(); tabB.position.set(-2.4, -0.7, -0.7);
      const rotor = new THREE.Group();
      const shaft = alongX(mesh(new THREE.CylinderGeometry(0.18, 0.18, 3, 16), M.shaft)); shaft.position.x = 3.5;
      const pinion = mesh(gearGeometry(12, 1.2, 0.2, 0.7), M.shaft); pinion.position.x = 4;
      rotor.add(shaft, pinion);
      const rings = [-1.1, 0.2, 1.4].map((x) => {
        const r = mesh(new THREE.TorusGeometry(2.25, 0.06, 8, 64), M.heat);
        r.rotation.y = Math.PI / 2;
        r.position.x = x;
        r.castShadow = false;
        r.userData.cid = item.component;
        return r;
      });
      g.add(can, rear, boss, bracket, tabA, tabB, rotor, ...rings);
      return {
        item, group: g,
        update: (d, ctx) => {
          rotor.rotation.x = spin(ctx, item.component!, Number(d.omega ?? 0));
          const heat = Number(d.heat ?? 0);
          const show = ctx.heatOn && heat > 0.3;
          rings.forEach((r, i) => { r.visible = show && heat > i * 3; });
          M.heat.opacity = Math.min(0.9, 0.25 + heat / 20);
        },
      };
    }
    case 'gearpair': {
      const wheel = new THREE.Group();
      wheel.position.z = 4.8;
      const gear = mesh(gearGeometry(36, 3.6, 0.2, 0.7), M.shaft);
      const hub = alongX(mesh(new THREE.CylinderGeometry(0.7, 0.7, 1.2, 24), M.darkMetal));
      wheel.add(gear, hub);
      const out = alongX(mesh(new THREE.CylinderGeometry(0.22, 0.22, 12.5, 16), M.shaft));
      out.position.set(5.2, 0, 4.8);
      g.add(wheel, out);
      const follow = String(o.follows ?? '');
      return {
        item, group: g,
        update: (d, ctx) => {
          const ratio = Number(d.ratio ?? 1);
          wheel.rotation.x = -(ctx.angles.get(follow) ?? 0) / ratio + Math.PI / 36;
        },
      };
    }
    case 'bearing': {
      const h = Number(o.height ?? 6);
      const base = mesh(new THREE.BoxGeometry(3, 0.6, 3.4), M.darkMetal); base.position.y = 0.3;
      const pillar = mesh(new THREE.BoxGeometry(1.4, h - 0.3, 2.2), M.plastic); pillar.position.y = (h - 0.3) / 2 + 0.3;
      const housing = alongX(mesh(new THREE.CylinderGeometry(0.95, 0.95, 1.6, 28), M.darkMetal)); housing.position.y = h;
      g.add(base, pillar, housing);
      return { item, group: g, update: noop };
    }
    case 'flywheel': {
      const R = Number(o.radius ?? 4.5);
      const wheel = new THREE.Group();
      const rim = alongX(mesh(new THREE.CylinderGeometry(R, R, 1.2, 72), M.metal));
      const hub = alongX(mesh(new THREE.CylinderGeometry(0.9, 0.9, 1.8, 24), M.darkMetal));
      wheel.add(rim, hub);
      for (let i = 0; i < 4; i++) {
        const s = mesh(new THREE.BoxGeometry(1.26, R * 1.7, 0.5), M.darkMetal);
        s.rotation.x = (i * Math.PI) / 4;
        wheel.add(s);
      }
      const mark = mesh(new THREE.BoxGeometry(1.3, 0.5, 0.9), M.shaft);
      mark.position.y = R - 0.4;
      wheel.add(mark);
      g.add(wheel);
      if (o.stand) {
        const shaft = alongX(mesh(new THREE.CylinderGeometry(0.22, 0.22, 3.6, 16), M.shaft)); shaft.position.x = 0.1;
        const post = mesh(new THREE.BoxGeometry(0.8, 6, 1.6), M.plastic); post.position.set(1.5, -3, 0);
        const foot = mesh(new THREE.BoxGeometry(2.4, 0.5, 3), M.darkMetal); foot.position.set(1.5, -5.75, 0);
        const housing = alongX(mesh(new THREE.CylinderGeometry(0.7, 0.7, 1, 24), M.darkMetal)); housing.position.x = 1.5;
        g.add(shaft, post, foot, housing);
      }
      const follow = String(o.follows ?? '');
      return {
        item, group: g,
        update: (d, ctx) => {
          if (d.omega !== undefined) { wheel.rotation.x = spin(ctx, item.component!, Number(d.omega)); return; }
          const ratio = Number(d.ratio ?? 1);
          wheel.rotation.x = -(ctx.angles.get(follow) ?? 0) / ratio;
        },
      };
    }
    case 'ambient': {
      const glass = mesh(new THREE.CylinderGeometry(0.26, 0.26, 2, 16), new THREE.MeshStandardMaterial({ color: '#cfe3f7', transparent: true, opacity: 0.35, roughness: 0.1 }));
      glass.position.y = 1;
      const stem = mesh(new THREE.CylinderGeometry(0.11, 0.11, 1.6, 10), M.heat); stem.position.y = 0.9;
      const bulb = mesh(new THREE.SphereGeometry(0.42, 18, 14), M.heat);
      g.add(glass, stem, bulb);
      return { item, group: g, update: noop };
    }
    case 'breadboard': {
      const top = new THREE.MeshStandardMaterial({ map: breadboardTexture(), roughness: 0.9 });
      const body = new THREE.Mesh(new THREE.BoxGeometry(30, 0.8, 11), [M.board, M.board, top, M.board, M.board, M.board]);
      body.position.y = 0.4;
      g.add(body);
      return { item, group: g, update: noop };
    }
    case 'dip8': {
      const body = mesh(new THREE.BoxGeometry(2, 0.7, 1.6), new THREE.MeshStandardMaterial({ color: '#1E1F22', roughness: 0.6 }));
      body.position.y = 0.35;
      const label = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 0.7), new THREE.MeshStandardMaterial({ map: textTexture([String(o.label ?? '')], 256, 104, '#1E1F22', '#BFC3C7', 54), roughness: 0.7 }));
      label.rotation.x = -Math.PI / 2;
      label.position.y = 0.705;
      const notch = mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.02, 16, 1, false, 0, Math.PI), new THREE.MeshStandardMaterial({ color: '#3A3B3F' }));
      notch.position.set(-1, 0.71, 0);
      notch.rotation.y = Math.PI / 2;
      g.add(body, label, notch);
      for (const x of [-0.75, -0.25, 0.25, 0.75]) {
        for (const z of [-0.86, 0.86]) {
          const pin = mesh(new THREE.BoxGeometry(0.18, 0.5, 0.12), M.metal);
          pin.position.set(x, 0.12, z);
          g.add(pin);
        }
      }
      return { item, group: g, update: noop };
    }
    case 'resistor': {
      const body = alongX(mesh(new THREE.CylinderGeometry(0.3, 0.3, 1.3, 24), new THREE.MeshStandardMaterial({ color: '#D8C39A', roughness: 0.6 })));
      const lead = alongX(mesh(new THREE.CylinderGeometry(0.045, 0.045, 2.2, 8), M.metal));
      g.add(lead, body);
      resistorBands(Number(o.ohms ?? 1000)).forEach((c, i) => {
        const band = alongX(mesh(new THREE.CylinderGeometry(0.31, 0.31, 0.12, 24), new THREE.MeshStandardMaterial({ color: c, roughness: 0.5 })));
        band.position.x = [-0.42, -0.22, -0.02, 0.4][i];
        g.add(band);
      });
      for (const x of [-1.1, 1.1]) {
        const leg = mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.4, 8), M.metal);
        leg.position.set(x, -0.2, 0);
        g.add(leg);
      }
      return { item, group: g, update: noop };
    }
    case 'electrolytic': {
      const can = mesh(new THREE.CylinderGeometry(0.6, 0.6, 2.2, 32), new THREE.MeshStandardMaterial({ color: '#2B4A8A', roughness: 0.4, metalness: 0.2 }));
      can.position.y = 1.1;
      const stripe = mesh(new THREE.BoxGeometry(0.3, 2.1, 0.06), new THREE.MeshStandardMaterial({ color: '#9FB3D9', roughness: 0.5 }));
      stripe.position.set(0.25, 1.1, 0.57);
      const cap = mesh(new THREE.CylinderGeometry(0.57, 0.57, 0.04, 32), M.metal);
      cap.position.y = 2.22;
      g.add(can, stripe, cap);
      return { item, group: g, update: noop };
    }
    case 'ceramic': {
      const disc = mesh(new THREE.SphereGeometry(0.45, 20, 14), new THREE.MeshStandardMaterial({ color: '#D9A441', roughness: 0.6 }));
      disc.scale.set(1, 1, 0.35);
      disc.position.y = 0.75;
      g.add(disc);
      return { item, group: g, update: noop };
    }
    case 'led': {
      const mat = new THREE.MeshStandardMaterial({ color: '#C8282E', roughness: 0.25, transparent: true, opacity: 0.92, emissive: '#FF2A2A', emissiveIntensity: 0 });
      const body = mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.6, 28), mat); body.position.y = 0.42;
      const dome = mesh(new THREE.SphereGeometry(0.5, 28, 14, 0, Math.PI * 2, 0, Math.PI / 2), mat); dome.position.y = 0.72;
      const flange = mesh(new THREE.CylinderGeometry(0.58, 0.58, 0.12, 28), mat); flange.position.y = 0.12;
      const light = new THREE.PointLight('#ff3b3b', 0, 14, 1.6);
      light.position.y = 1.6;
      g.add(body, dome, flange, light);
      return {
        item, group: g,
        update: (d) => {
          const b = Math.min(1.2, Math.max(0, Number(d.current ?? 0)) / 0.02);
          mat.emissiveIntensity = b * 2.2;
          light.intensity = b * 60;
        },
      };
    }
    case 'battery9v': {
      const body = mesh(new THREE.BoxGeometry(2.6, 1.75, 4.8), new THREE.MeshStandardMaterial({ color: '#2E2E2E', roughness: 0.6 }));
      body.position.y = 0.875;
      const label = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 3), new THREE.MeshStandardMaterial({ map: textTexture(['9V', item.component ?? ''], 160, 220, '#2E2E2E', '#D9D9D9', 72), roughness: 0.7 }));
      label.rotation.x = -Math.PI / 2;
      label.position.set(0, 1.755, 0.6);
      const plus = mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.3, 6), M.metal); plus.position.set(-0.5, 1.9, -1.6);
      const minus = mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.3, 20), M.metal); minus.position.set(0.5, 1.9, -1.6);
      g.add(body, label, plus, minus);
      return { item, group: g, update: noop };
    }
    case 'torsionRig': {
      const base = mesh(new THREE.BoxGeometry(16, 0.6, 10), M.darkMetal); base.position.y = 0.3;
      const postL = mesh(new THREE.BoxGeometry(0.8, 21, 0.8), M.plastic); postL.position.set(-6.5, 10.8, 0);
      const postR = postL.clone(); postR.position.x = 6.5;
      const beam = mesh(new THREE.BoxGeometry(14.6, 1, 1.6), M.plastic); beam.position.y = 21.3;
      const clamp = mesh(new THREE.BoxGeometry(1.6, 1, 1.6), M.darkMetal); clamp.position.y = 20.4;
      g.add(base, postL, postR, beam, clamp);

      const springGroup = new THREE.Group();
      const helix: THREE.Vector3[] = [];
      for (let i = 0; i <= 240; i++) {
        const s = i / 240;
        const a = s * Math.PI * 2 * 9;
        helix.push(new THREE.Vector3(Math.cos(a) * 1.1, 20 - s * 6, Math.sin(a) * 1.1));
      }
      const spring = mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(helix), 480, 0.12, 8, false), M.shaft);
      spring.userData.cid = String(o.spring ?? '');
      springGroup.add(spring);

      const rotor = new THREE.Group();
      const shaft = mesh(new THREE.CylinderGeometry(0.25, 0.25, 17, 16), M.shaft);
      shaft.position.y = 11.5;
      const disc = mesh(new THREE.CylinderGeometry(6, 6, 1.2, 72), M.metal);
      disc.position.y = 9.5;
      const mark = mesh(new THREE.BoxGeometry(1.4, 0.3, 1.2), M.shaft);
      mark.position.set(5.1, 10.2, 0);
      rotor.add(shaft, disc, mark);
      for (let i = 0; i < 3; i++) {
        const s = mesh(new THREE.BoxGeometry(10, 0.12, 0.5), M.darkMetal);
        s.position.y = 10.12;
        s.rotation.y = (i * Math.PI) / 3;
        rotor.add(s);
      }
      const vane = mesh(new THREE.BoxGeometry(0.15, 1.6, 2), M.darkMetal);
      vane.position.y = 2.4;
      vane.userData.cid = String(o.damper ?? '');
      rotor.add(vane);
      const cup = mesh(new THREE.CylinderGeometry(1.4, 1.4, 2.2, 32), new THREE.MeshStandardMaterial({ color: '#C99A3A', roughness: 0.3, transparent: true, opacity: 0.45 }));
      cup.position.y = 1.7;
      cup.userData.cid = String(o.damper ?? '');
      g.add(springGroup, rotor, cup);
      return {
        item, group: g,
        update: (d) => {
          const tw = Number(d.twist ?? 0);
          rotor.rotation.y = tw;
          springGroup.rotation.y = tw * 0.5;
        },
      };
    }
    case 'ground': {
      const plate = mesh(new THREE.BoxGeometry(1.8, 0.14, 1.8), M.darkMetal); plate.position.y = 0.07;
      const post = mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.7, 10), M.metal); post.position.y = 0.55;
      g.add(plate, post);
      [1.3, 0.9, 0.5].forEach((w, i) => {
        const bar = mesh(new THREE.BoxGeometry(w, 0.08, 0.14), M.metal);
        bar.position.set(0, 0.2, -0.3 + i * 0.3);
        g.add(bar);
      });
      return { item, group: g, update: noop };
    }
    case 'inductor': {
      const copper = new THREE.MeshStandardMaterial({ color: '#B87333', metalness: 0.8, roughness: 0.35 });
      for (let i = 0; i < 7; i++) {
        const turn = mesh(new THREE.TorusGeometry(0.55, 0.11, 10, 28), copper);
        turn.rotation.y = Math.PI / 2;
        turn.position.x = -0.9 + i * 0.3;
        g.add(turn);
      }
      const core = alongX(mesh(new THREE.CylinderGeometry(0.38, 0.38, 2.2, 20), M.darkMetal));
      const lead = alongX(mesh(new THREE.CylinderGeometry(0.045, 0.045, 2.8, 8), M.metal));
      g.add(core, lead);
      for (const x of [-1.4, 1.4]) {
        const leg = mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.5, 8), M.metal);
        leg.position.set(x, -0.25, 0);
        g.add(leg);
      }
      return { item, group: g, update: noop };
    }
    case 'gearbox': {
      const body = mesh(new THREE.BoxGeometry(2.8, 2.6, 2.4), M.darkMetal);
      const lid = mesh(new THREE.BoxGeometry(2.9, 0.25, 2.5), M.metal); lid.position.y = 1.4;
      const post = mesh(new THREE.BoxGeometry(1.6, 4.7, 1.8), M.plastic); post.position.y = -3.65;
      const inShaft = new THREE.Group(); inShaft.position.x = -1.9;
      const outShaft = new THREE.Group(); outShaft.position.x = 1.9;
      for (const s of [inShaft, outShaft]) {
        const c = alongX(mesh(new THREE.CylinderGeometry(0.22, 0.22, 1, 16), M.shaft));
        const key = mesh(new THREE.BoxGeometry(0.6, 0.12, 0.12), M.metal); key.position.y = 0.24;
        s.add(c, key);
      }
      g.add(body, lid, post, inShaft, outShaft);
      return {
        item, group: g,
        update: (d, ctx) => {
          inShaft.rotation.x = spin(ctx, `${item.component}.in`, Number(d.win ?? 0));
          outShaft.rotation.x = spin(ctx, `${item.component}.out`, Number(d.wout ?? 0));
        },
      };
    }
    case 'coilspring': {
      const coil = new THREE.Group();
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= 200; i++) {
        const s = i / 200, a = s * Math.PI * 2 * 7;
        pts.push(new THREE.Vector3(-2 + s * 3.4, Math.cos(a) * 0.85, Math.sin(a) * 0.85));
      }
      coil.add(mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 400, 0.1, 8, false), M.shaft));
      const collar = alongX(mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.4, 20), M.darkMetal)); collar.position.x = -2.1;
      const anchor = mesh(new THREE.BoxGeometry(0.8, 2.4, 2.4), M.plastic); anchor.position.x = 1.8;
      const post = mesh(new THREE.BoxGeometry(0.8, 4.8, 1.2), M.plastic); post.position.set(1.8, -3.6, 0);
      g.add(coil, collar, anchor, post);
      return {
        item, group: g,
        update: (d) => {
          const tw = Number(d.twist ?? 0);
          collar.rotation.x = tw;
          coil.rotation.x = tw * 0.5;
        },
      };
    }
    case 'heatblock': {
      const mat = new THREE.MeshStandardMaterial({ color: '#AEB7C2', metalness: 0.7, roughness: 0.4, emissive: '#FF5A3C', emissiveIntensity: 0 });
      const base = mesh(new THREE.BoxGeometry(2.4, 0.8, 2.4), mat); base.position.y = 0.4;
      g.add(base);
      for (let i = 0; i < 5; i++) {
        const fin = mesh(new THREE.BoxGeometry(2.4, 0.9, 0.16), mat);
        fin.position.set(0, 1.25, -1 + i * 0.5);
        g.add(fin);
      }
      return { item, group: g, update: (d, ctx) => { mat.emissiveIntensity = ctx.heatOn ? Math.min(0.8, Math.max(0, Number(d.heat ?? 0)) / 50) : 0; } };
    }
    case 'thermalpad': {
      const slab = mesh(new THREE.BoxGeometry(2.4, 0.4, 1.2), new THREE.MeshStandardMaterial({ color: '#8B95A1', roughness: 0.8 }));
      slab.position.y = 0.2;
      const stripe = mesh(new THREE.BoxGeometry(2.42, 0.08, 1.22), M.heat);
      stripe.position.y = 0.3;
      g.add(slab, stripe);
      return { item, group: g, update: noop };
    }
    default:
      return buildModelExt(item, M);
  }
}

function breadboardTexture(): THREE.CanvasTexture {
  const W = 1200, H = 440;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d')!;
  g.fillStyle = '#E6E8E1'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#D2D5CC'; g.fillRect(0, H / 2 - 10, W, 20);
  const hole = (x: number, y: number) => { g.fillStyle = '#9EA39A'; g.fillRect(x - 3, y - 3, 6, 6); };
  for (let x = 30; x < W - 20; x += 20) {
    for (let r = 0; r < 5; r++) { hole(x, 90 + r * 20); hole(x, H / 2 + 30 + r * 20); }
    hole(x, 30); hole(x, 50); hole(x, H - 50); hole(x, H - 30);
  }
  g.strokeStyle = '#C0392B'; g.lineWidth = 3;
  g.beginPath(); g.moveTo(20, 16); g.lineTo(W - 20, 16); g.moveTo(20, H - 64); g.lineTo(W - 20, H - 64); g.stroke();
  g.strokeStyle = '#2D5BB5';
  g.beginPath(); g.moveTo(20, 64); g.lineTo(W - 20, 64); g.moveTo(20, H - 16); g.lineTo(W - 20, H - 16); g.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

export const DOMAIN_LABEL: Record<Domain, string> = {
  electrical: 'Electrical',
  rotational: 'Rotational',
  translational: 'Translational',
  thermal: 'Thermal',
  fluid: 'Fluid',
};
