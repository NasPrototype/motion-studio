import * as THREE from 'three';
import type { Drive, VisualItem } from '../sim/scenes';
import type { FrameCtx, Mats, Model } from './viewport';

/**
 * 3D models for the mechanical, fluid, robotics and propulsion parts. Each one is drawn in its
 * own frame (+Y up, shafts along X) and animated from the `Drive` values its scene supplies.
 */

const MAX_RATE = 4 * Math.PI;
const num = (v: unknown, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function mesh(geo: THREE.BufferGeometry, mat: THREE.Material): THREE.Mesh {
  return new THREE.Mesh(geo, mat);
}
function alongX(m: THREE.Mesh): THREE.Mesh { m.rotation.z = Math.PI / 2; return m; }
function alongZ(m: THREE.Mesh): THREE.Mesh { m.rotation.x = Math.PI / 2; return m; }
function box(w: number, h: number, d: number, mat: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const m = mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  return m;
}
function cylX(r: number, len: number, mat: THREE.Material, x = 0, y = 0, z = 0, seg = 24): THREE.Mesh {
  const m = alongX(mesh(new THREE.CylinderGeometry(r, r, len, seg), mat));
  m.position.set(x, y, z);
  return m;
}
function spin(ctx: FrameCtx, id: string, omega: number): number {
  const rate = Math.sign(omega) * Math.min(Math.abs(omega), MAX_RATE);
  const a = (ctx.angles.get(id) ?? 0) + rate * ctx.simDt;
  ctx.angles.set(id, a);
  return a;
}

function labelTexture(title: string, sub = '', bg = '#1B232C', fg = '#E3EBF3'): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = bg; g.fillRect(0, 0, 256, 128);
  g.fillStyle = fg; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = '600 40px "IBM Plex Mono", ui-monospace, monospace';
  g.fillText(title, 128, sub ? 50 : 64);
  if (sub) { g.font = '500 24px "IBM Plex Mono", ui-monospace, monospace'; g.globalAlpha = 0.75; g.fillText(sub, 128, 92); }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** A helical coil from x = 0 to x = len; scale.x stretches it. */
function coil(len: number, r: number, turns: number, wire: number, mat: THREE.Material): THREE.Mesh {
  const pts: THREE.Vector3[] = [];
  const n = turns * 24;
  for (let i = 0; i <= n; i++) {
    const s = i / n, a = s * Math.PI * 2 * turns;
    pts.push(new THREE.Vector3(s * len, Math.cos(a) * r, Math.sin(a) * r));
  }
  return mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), n * 2, wire, 8, false), mat);
}

/** Simple spur gear about X: a disc with radial teeth. */
function gear(r: number, width: number, teeth: number, mat: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  g.add(cylX(r, width, mat, 0, 0, 0, 32));
  for (let i = 0; i < teeth; i++) {
    const t = box(width, r * 0.28, r * 0.22, mat);
    const a = (i / teeth) * Math.PI * 2;
    t.position.set(0, Math.cos(a) * r, Math.sin(a) * r);
    t.rotation.x = -a;
    g.add(t);
  }
  return g;
}

function post(h: number, mat: THREE.Material, top: number, w = 1, d = 1): THREE.Mesh {
  // A support column from the floor (y = top − h) up to `top`, in the part's frame.
  return box(w, h, d, mat, 0, top - h / 2, 0);
}

const steel = () => new THREE.MeshStandardMaterial({ color: '#AEB7C2', metalness: 0.75, roughness: 0.33 });

export function buildModelExt(item: VisualItem, M: Mats): Model {
  const g = new THREE.Group();
  const noop = () => {};
  const o = item.opts ?? {};
  const cid = (m: THREE.Object3D, id: unknown) => { m.traverse((x) => { x.userData.cid = String(id); }); return m; };

  switch (item.kind) {
    // ---------------------------------------------------------------- electrical / control
    case 'device': {
      const w = num(o.w, 3), h = num(o.h, 1.6), d = num(o.d, 2);
      const body = box(w, h, d, M.plastic, 0, h / 2, 0);
      const lid = box(w + 0.06, 0.12, d + 0.06, M.darkMetal, 0, h + 0.02, 0);
      const face = mesh(new THREE.PlaneGeometry(w * 0.82, h * 0.62), new THREE.MeshBasicMaterial({ map: labelTexture(String(o.label ?? 'DEVICE'), String(o.sub ?? '')) }));
      face.position.set(0, h / 2, d / 2 + 0.011);
      const ledMat = new THREE.MeshStandardMaterial({ color: '#2F3A44', emissive: String(o.accent ?? '#6DC48A'), emissiveIntensity: 0 });
      const led = mesh(new THREE.SphereGeometry(0.12, 12, 8), ledMat);
      led.position.set(w / 2 - 0.3, h - 0.25, d / 2 + 0.02);
      g.add(body, lid, face, led);
      for (const x of [-w / 2 + 0.4, w / 2 - 0.4]) for (const z of [-d / 2 + 0.4, d / 2 - 0.4]) g.add(box(0.3, 0.12, 0.3, M.darkMetal, x, 0.06, z));
      if (o.post) g.add(post(num(o.post), M.plastic, 0, 1, 1));
      return { item, group: g, update: (dr) => { ledMat.emissiveIntensity = clamp(num(dr.level, 0), 0, 1) * 1.6; } };
    }
    case 'diode': {
      const body = cylX(0.32, 1.4, new THREE.MeshStandardMaterial({ color: '#1C1F23', roughness: 0.5 }), 0, 0, 0, 20);
      const band = cylX(0.335, 0.22, new THREE.MeshStandardMaterial({ color: '#C9CED6', metalness: 0.6, roughness: 0.4 }), 0.5, 0, 0, 20);
      const lead = cylX(0.04, 2.3, M.metal, 0, 0, 0, 8);
      g.add(body, band, lead);
      for (const x of [-1.1, 1.1]) g.add(box(0.08, 0.6, 0.08, M.metal, x, -0.3, 0));
      return { item, group: g, update: noop };
    }
    case 'powerres': {
      const mat = new THREE.MeshStandardMaterial({ color: '#E6DFCF', roughness: 0.85, emissive: '#FF5A3C', emissiveIntensity: 0 });
      g.add(box(3, 0.9, 0.9, mat, 0, 0.9, 0));
      for (const x of [-1.6, 1.6]) { g.add(box(0.2, 1.1, 1.0, M.metal, x, 0.9, 0)); g.add(box(0.12, 0.45, 0.6, M.darkMetal, x, 0.22, 0)); }
      const print = mesh(new THREE.PlaneGeometry(2.2, 0.5), new THREE.MeshBasicMaterial({ map: labelTexture(String(o.label ?? '10 Ω 25 W'), '', '#E6DFCF', '#3A3A3A') }));
      print.position.set(0, 0.9, 0.452);
      g.add(print);
      return { item, group: g, update: (d, ctx) => { mat.emissiveIntensity = ctx.heatOn ? clamp(num(d.heat) / 120, 0, 0.9) : 0; } };
    }

    // ---------------------------------------------------------------- translational
    case 'mass': {
      const s = num(o.size, 2.4);
      const blk = new THREE.Group();
      blk.add(box(s, s, s, steel(), 0, s / 2, 0));
      const tag = mesh(new THREE.PlaneGeometry(s * 0.7, s * 0.35), new THREE.MeshBasicMaterial({ map: labelTexture(String(o.label ?? 'MASS'), String(o.sub ?? ''), '#2A333D') }));
      tag.position.set(0, s / 2, s / 2 + 0.011);
      blk.add(tag, box(s * 0.5, 0.2, s * 0.5, M.rod, 0, s + 0.1, 0));
      g.add(blk);
      const gain = num(o.gain, 10);
      return { item, group: g, update: (d) => { blk.position.y = clamp(num(d.x) * gain, -1.5, 4); } };
    }
    case 'linspring': {
      const len = 3.6;
      const c = coil(len, 0.6, 9, 0.09, M.rod);
      c.position.x = -1.8;
      const left = cylX(0.75, 0.16, M.darkMetal, -1.9);
      const right = cylX(0.75, 0.16, M.darkMetal, 1.9);
      g.add(c, left, right, post(0.45, M.plastic, -0.75, 0.4, 0.8));
      const gain = num(o.gain, 10);
      return {
        item, group: g,
        update: (d) => {
          const k = 1 - clamp(num(d.defl) * gain, -1.2, 1.2) / len;
          c.scale.x = k;
          right.position.x = -1.8 + len * k + 0.1;
        },
      };
    }
    case 'lindamper': {
      const body = cylX(0.5, 2.3, M.darkMetal, -0.85);
      const rod = new THREE.Group();
      rod.add(cylX(0.15, 2, M.metal, 1.2), cylX(0.32, 0.25, M.rod, 2.1));
      const eye = cylX(0.32, 0.25, M.rod, -2.1);
      g.add(body, rod, eye, post(0.7, M.plastic, -0.5, 0.4, 0.8));
      const gain = num(o.gain, 10);
      return { item, group: g, update: (d) => { rod.position.x = clamp(num(d.stroke) * gain, -1, 1); } };
    }
    case 'force': {
      const arrow = new THREE.Group();
      arrow.add(mesh(new THREE.CylinderGeometry(0.12, 0.12, 2.4, 12), M.rod).translateY(2.2));
      const head = mesh(new THREE.ConeGeometry(0.42, 0.9, 20), M.rod);
      head.rotation.x = Math.PI;
      head.position.y = 0.6;
      arrow.add(head);
      g.add(arrow, box(1, 0.1, 1, M.darkMetal, 0, 0.05, 0));
      return { item, group: g, update: (d) => { const up = num(d.F, -1) > 0; arrow.rotation.z = up ? Math.PI : 0; arrow.position.y = up ? 3.6 : 0; } };
    }
    case 'road': {
      const asphalt = new THREE.MeshStandardMaterial({ color: '#2B3138', roughness: 0.95 });
      g.add(box(6, 0.3, 2.4, asphalt, 0, 0.15, 0));
      const bump = mesh(new THREE.SphereGeometry(1, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), asphalt);
      bump.scale.set(1.4, 0.4, 1.1);
      bump.position.y = 0.3;
      const rise = new THREE.Group();
      rise.add(mesh(new THREE.CylinderGeometry(0.14, 0.14, 1.6, 12), M.rod).translateY(1.1), box(1, 0.14, 1, M.rod, 0, 1.95, 0));
      g.add(bump, rise);
      const gain = num(o.gain, 10);
      return { item, group: g, update: (d) => { rise.position.y = clamp(num(d.h) * gain, 0, 2); } };
    }
    case 'anchor': {
      g.add(box(0.8, 3.2, 2.4, M.darkMetal, 0, 1.6, 0));
      for (let i = 0; i < 5; i++) {
        const s = box(0.06, 0.9, 0.12, M.rod, 0.43, 0.5 + i * 0.55, 0);
        s.rotation.x = Math.PI / 4;
        g.add(s);
      }
      g.add(box(0.4, 0.4, 0.4, M.rod, 0.6, 1.6, 0));
      return { item, group: g, update: noop };
    }
    case 'rackpinion': {
      const pin = gear(0.9, 0.6, 14, M.shaft);
      const stub = cylX(0.18, 1.8, M.shaft, -0.9);
      const rack = new THREE.Group();
      rack.add(box(0.6, 0.4, 5.2, M.rod, 0, -1.2, 0));
      for (let i = 0; i < 16; i++) rack.add(box(0.6, 0.18, 0.16, M.rod, 0, -0.93, -2.4 + i * 0.32));
      const stand = post(0.6, M.plastic, -1.4, 0.8, 1.2); stand.position.x = -1.4;
      g.add(pin, stub, rack, stand, box(0.5, 0.6, 1.2, M.plastic, -1.4, -1.1, 0));
      const gain = num(o.gain, 10);
      return {
        item, group: g,
        update: (d, ctx) => {
          pin.rotation.x = spin(ctx, item.component ?? 'rp', num(d.omega));
          rack.position.z = clamp(num(d.x) * gain, -2, 2);
        },
      };
    }

    // ---------------------------------------------------------------- robotics
    case 'link': {
      const L = num(o.length, 4);
      const housing = cylX(0.7, 1.4, M.darkMetal);
      const stub = cylX(0.16, 1.2, M.shaft, -0.9);
      const arm = new THREE.Group();
      arm.add(box(0.6, 0.6, L, steel(), 0, 0, L / 2));
      const tip = mesh(new THREE.SphereGeometry(0.45, 16, 12), M.rod);
      tip.position.z = L;
      arm.add(tip);
      g.add(housing, stub, arm);
      if (o.post) g.add(post(num(o.post), M.plastic, -0.7, 1, 1));
      return { item, group: g, update: (d) => { arm.rotation.x = -num(d.theta); } };
    }

    // ---------------------------------------------------------------- fluid
    case 'tank': {
      const tint = String(o.tint ?? '#9FC6FF');
      const shell = new THREE.MeshStandardMaterial({ color: '#C7CED6', metalness: 0.6, roughness: 0.35 });
      g.add(mesh(new THREE.CylinderGeometry(1.4, 1.4, 3.6, 36), shell).translateY(3.2));
      for (const y of [1.4, 5.0]) {
        const dome = mesh(new THREE.SphereGeometry(1.4, 36, 18), shell);
        dome.scale.y = 0.45; dome.position.y = y;
        g.add(dome);
      }
      const band = mesh(new THREE.CylinderGeometry(1.42, 1.42, 0.9, 36, 1, true), new THREE.MeshBasicMaterial({ map: labelTexture(String(o.label ?? 'TANK'), String(o.sub ?? ''), tint, '#111820'), side: THREE.DoubleSide }));
      band.position.y = 3.6;
      g.add(band);
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2 + 0.5;
        g.add(box(0.2, 1.3, 0.2, M.darkMetal, Math.cos(a) * 1.1, 0.65, Math.sin(a) * 1.1));
      }
      g.add(cylX(0.22, 0.6, M.pipe, 1.25, 0.9, 0), mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.6, 12), M.pipe).translateY(1.0).translateX(0.95));
      const gauge = new THREE.Group();
      gauge.position.set(0, 6.0, 0);
      gauge.add(alongZ(mesh(new THREE.CylinderGeometry(0.45, 0.45, 0.16, 24), new THREE.MeshStandardMaterial({ color: '#F2F4F6' }))));
      const needle = box(0.06, 0.38, 0.04, new THREE.MeshBasicMaterial({ color: '#D9412B' }), 0, 0.16, 0.1);
      const pivot = new THREE.Group(); pivot.position.z = 0.0; pivot.add(needle);
      gauge.add(pivot, mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.6, 8), M.metal).translateY(-0.4));
      g.add(gauge);
      const full = num(o.full, 30e5);
      return { item, group: g, update: (d) => { pivot.rotation.z = 2.2 - clamp(num(d.p) / full, 0, 1) * 4.4; } };
    }
    case 'reservoir': {
      const wall = new THREE.MeshStandardMaterial({ color: '#8C98A5', metalness: 0.3, roughness: 0.6, transparent: true, opacity: 0.55 });
      g.add(box(3, 0.12, 2.4, M.darkMetal, 0, 0.06, 0));
      g.add(box(3, 1.6, 0.08, wall, 0, 0.8, 1.2), box(3, 1.6, 0.08, wall, 0, 0.8, -1.2), box(0.08, 1.6, 2.4, wall, 1.5, 0.8, 0), box(0.08, 1.6, 2.4, wall, -1.5, 0.8, 0));
      const level = box(2.9, 1.0, 2.3, M.fluid, 0, 0.62, 0);
      g.add(level, cylX(0.22, 0.5, M.pipe, 1.65, 0.6, 0));
      return { item, group: g, update: noop };
    }
    case 'valve': {
      g.add(mesh(new THREE.SphereGeometry(0.55, 20, 14), M.metal), cylX(0.3, 2.5, M.pipe));
      for (const x of [-1.1, 1.1]) g.add(cylX(0.45, 0.14, M.darkMetal, x));
      g.add(mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.7, 10), M.darkMetal).translateY(0.75));
      const handle = new THREE.Group();
      handle.position.y = 1.1;
      handle.add(box(1.5, 0.12, 0.28, new THREE.MeshStandardMaterial({ color: '#E0663A', roughness: 0.5 }), 0.55, 0, 0));
      g.add(handle);
      if (o.post) g.add(post(num(o.post), M.plastic, -0.4, 0.5, 0.5));
      return { item, group: g, update: (d) => { handle.rotation.y = (1 - clamp(num(d.open), 0, 1)) * (Math.PI / 2); } };
    }
    case 'pipe': {
      const L = num(o.length, 5);
      g.add(cylX(0.28, L, M.pipe, 0, 0, 0, 18));
      for (const x of [-L / 2, L / 2]) g.add(cylX(0.45, 0.16, M.darkMetal, x));
      for (const x of [-L / 4, L / 4]) g.add(box(0.3, 1, 0.6, M.plastic, x, -0.65, 0));
      return { item, group: g, update: noop };
    }
    case 'orifice': {
      g.add(cylX(0.28, 2.4, M.pipe, 0, 0, 0, 18), cylX(0.58, 0.08, M.metal), cylX(0.45, 0.16, M.darkMetal, -1.15), cylX(0.45, 0.16, M.darkMetal, 1.15));
      g.add(box(0.3, 1, 0.6, M.plastic, 0, -0.65, 0));
      return { item, group: g, update: noop };
    }
    case 'pump': {
      g.add(cylX(1.0, 1.6, M.darkMetal, 0.2, 0, 0, 32), cylX(1.05, 0.2, M.metal, -0.7, 0, 0, 32));
      const rotor = gear(0.55, 0.12, 10, M.shaft);
      rotor.position.x = -0.85;
      g.add(rotor, cylX(0.18, 1.6, M.shaft, -1.5));
      g.add(alongZ(mesh(new THREE.CylinderGeometry(0.25, 0.25, 0.7, 14), M.pipe)).translateX(0.6).translateY(-0.2).translateZ(1.2));
      const out = alongZ(mesh(new THREE.CylinderGeometry(0.25, 0.25, 0.7, 14), M.pipe));
      out.position.set(0.6, -0.2, -1.2);
      g.add(out, box(2.6, 0.5, 2.0, M.plastic, 0.2, -1.25, 0));
      if (o.post) g.add(post(num(o.post), M.plastic, -1.5, 1.4, 1.4));
      return { item, group: g, update: (d, ctx) => { rotor.rotation.x = spin(ctx, item.component ?? 'pump', num(d.omega)); } };
    }
    case 'hydcylinder': {
      const inner = new THREE.Group();
      inner.add(cylX(0.7, 3.5, new THREE.MeshStandardMaterial({ color: '#3D6F99', metalness: 0.5, roughness: 0.4 }), -0.75, 0, 0, 28));
      inner.add(cylX(0.8, 0.3, M.darkMetal, -2.5), cylX(0.8, 0.3, M.darkMetal, 1.0));
      for (const x of [-2.2, 0.6]) inner.add(mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.5, 10), M.pipe).translateX(x).translateY(0.8));
      const rod = new THREE.Group();
      rod.add(cylX(0.25, 2.6, M.metal, 2.2), cylX(0.4, 0.3, M.rod, 3.4));
      inner.add(rod);
      if (o.vertical) inner.rotation.z = Math.PI / 2;
      else inner.add(box(0.4, 1.2, 1.0, M.plastic, -2.5, -0.9, 0));
      g.add(inner);
      const gain = num(o.gain, 10);
      return { item, group: g, update: (d) => { rod.position.x = clamp(num(d.x) * gain, -0.2, 2.6); } };
    }

    // ---------------------------------------------------------------- propulsion
    case 'thrustchamber': {
      const copper = new THREE.MeshStandardMaterial({ color: '#B87333', metalness: 0.8, roughness: 0.35, emissive: '#FF5A1F', emissiveIntensity: 0, side: THREE.DoubleSide });
      const prof = [[0.001, -2.3], [1.05, -2.3], [1.05, 0.3], [0.92, 0.72], [0.62, 1.05], [0.46, 1.25], [0.5, 1.45], [0.7, 2.2], [0.92, 3.2]].map(([r, y]) => new THREE.Vector2(r, y));
      const geo = new THREE.LatheGeometry(prof, 48);
      geo.rotateZ(-Math.PI / 2);
      g.add(mesh(geo, copper));
      const head = cylX(1.15, 0.45, M.metal, -2.45, 0, 0, 36);
      g.add(head);
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        g.add(cylX(0.08, 0.5, M.darkMetal, -2.45, Math.cos(a) * 0.95, Math.sin(a) * 0.95, 8));
      }
      g.add(cylX(0.18, 0.5, M.pipe, -2.55, 0.55, 0, 12), cylX(0.18, 0.5, M.pipe, -2.55, -0.55, 0, 12));
      g.add(mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.5, 10), M.darkMetal).translateY(1.25));
      if (o.post !== false) g.add(post(num(o.post, 2.2) - 1.05, M.plastic, -1.05, 0.9, 1.3));
      const plume = new THREE.Group();
      plume.position.x = 3.2;
      const outerGeo = new THREE.ConeGeometry(1.0, 1, 32, 1, true); outerGeo.translate(0, 0.5, 0); outerGeo.rotateZ(-Math.PI / 2);
      const innerGeo = new THREE.ConeGeometry(0.55, 1, 24, 1, true); innerGeo.translate(0, 0.5, 0); innerGeo.rotateZ(-Math.PI / 2);
      const outer = mesh(outerGeo, new THREE.MeshBasicMaterial({ color: '#FF9F5A', transparent: true, opacity: 0.32, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
      const core = mesh(innerGeo, new THREE.MeshBasicMaterial({ color: '#BCD6FF', transparent: true, opacity: 0.6, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
      const diamonds: THREE.Mesh[] = [];
      for (let i = 0; i < 4; i++) {
        const dm = mesh(new THREE.SphereGeometry(0.28, 12, 8), new THREE.MeshBasicMaterial({ color: '#F4F7FF', transparent: true, opacity: 0.7, depthWrite: false, blending: THREE.AdditiveBlending }));
        dm.scale.set(1.6, 0.8, 0.8);
        diamonds.push(dm);
        plume.add(dm);
      }
      plume.add(outer, core);
      plume.visible = false;
      outer.castShadow = false; core.castShadow = false;
      g.add(plume);
      const light = new THREE.PointLight('#FFB070', 0, 30, 2);
      light.position.set(5, 0, 0);
      g.add(light);
      const rated = num(o.rated, 2000);
      return {
        item, group: g,
        update: (d, ctx) => {
          const thrust = num(d.thrust);
          const frac = clamp(thrust / rated, 0, 1.6);
          plume.visible = thrust > rated * 0.02;
          if (plume.visible) {
            const flick = 1 + (Math.random() - 0.5) * 0.08;
            const len = 2 + 9 * frac;
            outer.scale.set(len * flick, 0.6 + 0.5 * frac, 0.6 + 0.5 * frac);
            core.scale.set(len * 0.55 * flick, 1, 1);
            diamonds.forEach((dm, i) => { dm.position.x = (0.9 + i * 1.25) * (0.6 + 0.5 * frac); dm.visible = frac > 0.3 && i < 1 + frac * 3; });
          }
          light.intensity = plume.visible ? 40 * frac : 0;
          copper.emissiveIntensity = ctx.heatOn ? clamp(num(d.heat) / 500, 0, 0.9) : 0;
        },
      };
    }
    case 'teststand': {
      const frame = new THREE.MeshStandardMaterial({ color: '#4E5A68', metalness: 0.55, roughness: 0.5 });
      g.add(box(16, 0.4, 7, new THREE.MeshStandardMaterial({ color: '#5E6670', roughness: 0.95 }), 2, 0.2, 0));
      for (const z of [-2.2, 2.2]) {
        g.add(box(0.5, 3.2, 0.5, frame, -4.4, 1.9, z), box(0.5, 3.2, 0.5, frame, -1.4, 1.9, z));
        g.add(box(9, 0.35, 0.35, frame, 0, 1.2, z));
      }
      g.add(box(0.6, 3.6, 5, frame, -4.6, 2.0, 0));
      const cell = box(0.9, 0.9, 0.9, new THREE.MeshStandardMaterial({ color: '#C9A227', metalness: 0.6, roughness: 0.35 }), -3.75, 3.0, 0);
      cid(cell, o.loadcell ?? '');
      const tag = mesh(new THREE.PlaneGeometry(0.85, 0.42), new THREE.MeshBasicMaterial({ map: labelTexture('LC', 'load cell', '#C9A227', '#111820') }));
      tag.position.set(-3.75, 3.0, 0.455);
      cid(tag, o.loadcell ?? '');
      g.add(cell, tag, box(1.2, 0.2, 2.4, frame, -2.8, 3.0, 0));
      const deflector = box(0.4, 5, 7, new THREE.MeshStandardMaterial({ color: '#7A6E62', roughness: 0.9 }), 15, 2.5, 0);
      deflector.rotation.z = -0.35;
      g.add(deflector);
      return { item, group: g, update: noop };
    }

    // ---------------------------------------------------------------- rigs
    case 'smdRig': {
      const rail = new THREE.MeshStandardMaterial({ color: '#4E5A68', metalness: 0.5, roughness: 0.5 });
      g.add(box(14, 0.3, 4, rail, 1, 0.15, 0), box(0.9, 5, 4.4, M.darkMetal, -6.3, 2.5, 0));
      const blk = new THREE.Group();
      blk.add(cid(box(2.6, 2.6, 2.6, steel(), 0, 1.9, 0), o.mass ?? ''));
      for (const x of [-0.8, 0.8]) for (const z of [-1, 1]) blk.add(cid(alongZ(mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.3, 16), M.darkMetal)).translateX(x).translateY(0.6).translateZ(z), o.mass ?? ''));
      const tag = mesh(new THREE.PlaneGeometry(1.8, 0.9), new THREE.MeshBasicMaterial({ map: labelTexture('1 kg', 'm', '#2A333D') }));
      tag.position.set(0, 1.9, 1.311);
      blk.add(cid(tag, o.mass ?? ''));
      const restX = 1.5;
      const spr = cid(coil(6, 0.45, 12, 0.07, M.rod), o.spring ?? '') as THREE.Mesh;
      spr.position.set(-5.85, 2.6, 0.7);
      const dampBody = cid(cylX(0.35, 3, M.darkMetal, -4.3, 1.2, -0.7), o.damper ?? '');
      const dampRod = new THREE.Group();
      dampRod.add(cid(cylX(0.1, 3.4, M.metal, -1.6, 1.2, -0.7), o.damper ?? ''));
      g.add(blk, spr, dampBody, dampRod);
      const gain = num(o.gain, 40);
      return {
        item, group: g,
        update: (d) => {
          const x = clamp(num(d.x) * gain, -3.5, 3.5);
          blk.position.x = restX + x;
          spr.scale.x = (restX + x - 1.3 + 5.85) / 6;
          dampRod.position.x = x;
        },
      };
    }
    case 'quarterCar': {
      const gain = num(o.gain, 20);
      const frame = new THREE.MeshStandardMaterial({ color: '#4E5A68', metalness: 0.5, roughness: 0.5 });
      const asphalt = new THREE.MeshStandardMaterial({ color: '#2B3138', roughness: 0.95 });
      const road = new THREE.Group();
      road.add(box(40, 0.4, 5, asphalt, 0, 0.2, 0));
      for (let i = -9; i <= 9; i++) road.add(box(1.2, 0.02, 0.18, new THREE.MeshBasicMaterial({ color: '#C9CED6' }), i * 2.2, 0.41, 2));
      const bump = mesh(new THREE.SphereGeometry(1, 32, 12, 0, Math.PI * 2, 0, Math.PI / 2), asphalt);
      bump.position.y = 0.4;
      road.add(bump);
      g.add(road);
      // Guide posts that hold the corner upright (a quarter-car rig constrains everything but heave).
      for (const z of [-3.6, 3.6]) g.add(box(0.4, 13, 0.4, frame, -4.8, 6.5, z));
      const wheel = new THREE.Group();
      const tire = mesh(new THREE.TorusGeometry(1.45, 0.55, 18, 48), new THREE.MeshStandardMaterial({ color: '#1A1D21', roughness: 0.85 }));
      const rim = alongZ(mesh(new THREE.CylinderGeometry(1.05, 1.05, 0.9, 32), M.metal));
      const spokes = new THREE.Group();
      for (let i = 0; i < 5; i++) { const s = box(0.25, 1.9, 0.2, M.darkMetal, 0, 0, 0.5); s.rotation.z = (i / 5) * Math.PI * 2; spokes.add(s); }
      wheel.add(cid(tire, o.tire ?? ''), cid(rim, o.wheel ?? ''), cid(spokes, o.wheel ?? ''));
      const hub = new THREE.Group();
      hub.add(cid(box(0.8, 0.8, 1.6, M.darkMetal, 0, 0, -0.6), o.wheel ?? ''), cid(box(3.6, 0.35, 0.6, M.darkMetal, -1.6, 0.4, -1.2), o.wheel ?? ''));
      const body = new THREE.Group();
      body.add(cid(box(8, 2.2, 5, new THREE.MeshStandardMaterial({ color: '#3D6F99', metalness: 0.4, roughness: 0.45 }), -1, 0, 0), o.body ?? ''));
      const tag = mesh(new THREE.PlaneGeometry(2.6, 1.1), new THREE.MeshBasicMaterial({ map: labelTexture('m_s', 'sprung', '#3D6F99') }));
      tag.position.set(-1, 0, 2.51);
      body.add(cid(tag, o.body ?? ''));
      const spr = cid(coil(4, 0.55, 8, 0.1, M.rod), o.spring ?? '') as THREE.Mesh;
      spr.rotation.z = Math.PI / 2;
      const dBody = cid(mesh(new THREE.CylinderGeometry(0.32, 0.32, 2.2, 16), M.darkMetal), o.damper ?? '');
      const dRod = cid(mesh(new THREE.CylinderGeometry(0.1, 0.1, 2.6, 10), M.metal), o.damper ?? '');
      g.add(wheel, hub, body, spr, dBody, dRod);
      const wheelY0 = 2.0, bodyY0 = 8.2;
      return {
        item, group: g,
        update: (d, ctx) => {
          const xu = clamp(num(d.xu) * gain, -1.5, 3), xs = clamp(num(d.xs) * gain, -2, 3.5);
          const wy = wheelY0 + xu, by = bodyY0 + xs;
          wheel.position.y = wy;
          wheel.rotation.z = -spin(ctx, `${item.component}.roll`, num(d.speed) / 0.3);
          tire.scale.set(1, 1, 1);
          hub.position.y = wy;
          body.position.y = by;
          const top = by - 1.1, bottom = wy + 0.6;
          spr.position.set(-2.0, bottom, -1.2);
          spr.scale.x = Math.max(0.2, (top - bottom) / 4);
          dBody.position.set(-0.6, bottom + 1.1, -1.2);
          dRod.position.set(-0.6, top - 1.3, -1.2);
          const h = num(d.roadH) * gain;
          const L = num(d.bumpLen, 0.8) * 3;
          bump.scale.set(L / 2, Math.max(0.001, num(d.bumpH, 0.06) * gain), 2.4);
          bump.position.x = clamp(num(d.bump) * 3, -30, 30);
          bump.visible = Math.abs(bump.position.x) < 25;
          road.position.y = 0;
          void h;
        },
      };
    }
    case 'robotArm': {
      const L1 = num(o.l1, 6), L2 = num(o.l2, 5);
      const orange = new THREE.MeshStandardMaterial({ color: '#E8803A', metalness: 0.3, roughness: 0.45 });
      g.add(box(16, 0.3, 10, new THREE.MeshStandardMaterial({ color: '#5E6670', roughness: 0.9 }), 0, 0.15, 0));
      g.add(cid(mesh(new THREE.CylinderGeometry(2.2, 2.6, 1.2, 40), M.darkMetal).translateY(0.9), o.j1 ?? ''));
      const turret = new THREE.Group();
      turret.position.y = 1.5;
      turret.add(cid(mesh(new THREE.CylinderGeometry(1.6, 1.8, 1.4, 36), orange).translateY(0.7), o.j1 ?? ''));
      turret.add(cid(box(1.4, 2.4, 2.6, orange, 0, 2.2, 0), o.j1 ?? ''));
      const shoulder = new THREE.Group();
      shoulder.position.y = 3.0;
      shoulder.add(cid(alongZ(mesh(new THREE.CylinderGeometry(0.9, 0.9, 2.8, 28), M.darkMetal)), o.j2 ?? ''));
      const upper = new THREE.Group();
      upper.add(cid(box(L1, 0.9, 1.0, orange, L1 / 2, 0, 0), o.j2 ?? ''));
      const elbow = new THREE.Group();
      elbow.position.x = L1;
      elbow.add(cid(alongZ(mesh(new THREE.CylinderGeometry(0.7, 0.7, 2.0, 24), M.darkMetal)), o.j3 ?? ''));
      const fore = new THREE.Group();
      fore.add(cid(box(L2, 0.7, 0.8, orange, L2 / 2, 0, 0), o.j3 ?? ''));
      const wrist = new THREE.Group();
      wrist.position.x = L2;
      wrist.add(box(0.6, 0.6, 1.4, M.darkMetal, 0, -0.3, 0));
      const fingerA = box(0.2, 1.0, 0.18, M.metal, 0, -1.0, 0.35);
      const fingerB = box(0.2, 1.0, 0.18, M.metal, 0, -1.0, -0.35);
      wrist.add(fingerA, fingerB);
      fore.add(wrist);
      elbow.add(fore);
      upper.add(elbow);
      shoulder.add(upper);
      turret.add(shoulder);
      g.add(turret);
      // Parallelogram linkage: a rod from the base sets the forearm's absolute angle.
      const linkRod = box(L1, 0.16, 0.16, M.metal, L1 / 2, 0, 1.15);
      const linkGroup = new THREE.Group(); linkGroup.add(linkRod); shoulder.add(linkGroup);
      const payload = box(1.0, 1.0, 1.0, new THREE.MeshStandardMaterial({ color: '#6DC48A', roughness: 0.6 }));
      g.add(payload);
      for (const [x, z] of [[8.5, -5.5], [8.5, 5.5]]) g.add(box(3, 1.6, 3, new THREE.MeshStandardMaterial({ color: '#3B4550', roughness: 0.8 }), x * 0.75, 0.8, z * 0.75));
      const tipWorld = new THREE.Vector3();
      let placed = new THREE.Vector3(6.4, 2.1, -4.1);
      let wasCarrying = false;
      return {
        item, group: g,
        update: (d) => {
          const q1 = num(d.q1), q2 = num(d.q2), q3 = num(d.q3);
          turret.rotation.y = q1;
          upper.rotation.z = q2;
          fore.rotation.z = q3 - q2;
          wrist.rotation.z = -q3;
          linkGroup.rotation.z = q2;
          const open = clamp(1 - num(d.grip), 0, 1);
          fingerA.position.z = 0.32 + open * 0.3;
          fingerB.position.z = -0.32 - open * 0.3;
          const carrying = Boolean(d.carry);
          g.updateMatrixWorld(true);
          wrist.getWorldPosition(tipWorld);
          g.worldToLocal(tipWorld);
          if (carrying) payload.position.set(tipWorld.x, tipWorld.y - 1.55, tipWorld.z);
          else {
            if (wasCarrying) placed = payload.position.clone();
            payload.position.copy(placed);
          }
          if (d.reset) placed = new THREE.Vector3(num(d.pickX, 6.4), 2.1, num(d.pickZ, -4.1));
          wasCarrying = carrying;
        },
      };
    }
  }
  // Unknown kinds draw as a small labelled box so a bad layout never crashes the view.
  g.add(box(1.5, 1.5, 1.5, M.plastic, 0, 0.75, 0));
  return { item, group: g, update: (_d: Drive) => {} };
}
