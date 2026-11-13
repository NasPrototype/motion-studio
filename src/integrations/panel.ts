import type { Simulator } from '../sim/core';
import type { Component } from '../sim/components';
import type { Trace } from '../sim/scenes';
import { DeviceLink, type LinkMode } from '../hw/link';
import { SerialTransport, serialSupported, WebSocketTransport } from '../hw/transports';
import { channelsFor, defaultBindings, type EngineConfig, EngineLink, type EngineProtocol } from './unreal';
import { download, h, storage, toast } from '../ui/dom';

export interface InputTarget {
  id: string;
  label: string;
  apply(v: number): void;
}

export interface IntegrationHost {
  sim(): Simulator;
  components(): Component[];
  traces(): Trace[];
  sceneName(): string;
  overlay(traceLabel: string, t: number, value: number): void;
  inputTargets(): InputTarget[];
  exportGLB(): Promise<ArrayBuffer>;
  setStatus(s: { device: 'off' | LinkMode | 'armed'; engine: boolean }): void;
  log(lines: string[], status: string): void;
}

interface Saved {
  transport: 'serial' | 'ws';
  wsUrl: string;
  baud: number;
  engine: Omit<EngineConfig, 'bindings'>;
  bindingOverrides: Record<string, { actor?: string; property?: string; enabled?: boolean }>;
}

const DEFAULTS: Saved = {
  transport: serialSupported() ? 'serial' : 'ws',
  wsUrl: 'ws://localhost:8765',
  baud: 115200,
  engine: { protocol: 'remote-control', url: 'ws://127.0.0.1:30020', levelPath: '/Game/Maps/Studio.Studio:PersistentLevel', rateHz: 20 },
  bindingOverrides: {},
};

export class IntegrationsPanel {
  readonly link: DeviceLink;
  readonly engine: EngineLink;
  private readonly dlg: HTMLDialogElement;
  private tab: 'hardware' | 'engine' = 'hardware';
  private saved: Saved;
  private log: string[] = [];
  private overlayMap = new Map<string, string>();
  private inputMap = new Map<string, string>();
  private stopReach = false;
  private valueCells = new Map<string, HTMLElement>();
  private refreshTimer = 0;

  constructor(private readonly host: IntegrationHost) {
    this.saved = { ...DEFAULTS, ...storage.get<Partial<Saved>>('ms-integrations', {}) };
    this.saved.engine = { ...DEFAULTS.engine, ...this.saved.engine };
    this.dlg = h('dialog', { className: 'dlg dlg-wide', ariaLabel: 'Integrations' });
    this.dlg.addEventListener('close', () => window.clearInterval(this.refreshTimer));
    document.body.append(this.dlg);

    this.link = new DeviceLink({
      onSample: (values) => this.sample(values),
      onHello: () => this.defaultMaps(),
      onLog: (line) => {
        this.log.push(line);
        if (this.log.length > 400) this.log.splice(0, this.log.length - 400);
        this.host.log(this.log, this.link.status);
      },
      onState: () => { this.pushStatus(); this.render(); },
    });
    this.engine = new EngineLink({ ...this.saved.engine, bindings: [] }, () => { this.pushStatus(); this.render(); });
  }

  open(tab?: 'hardware' | 'engine'): void {
    if (tab) this.tab = tab;
    this.render();
    if (!this.dlg.open) this.dlg.showModal();
    window.clearInterval(this.refreshTimer);
    this.refreshTimer = window.setInterval(() => this.refreshValues(), 250);
  }

  /** Call after the scene changes so bindings and mappings follow the new parts. */
  sceneChanged(): void {
    const comps = this.host.components();
    this.engine.config.bindings = defaultBindings(comps).map((b) => ({ ...b, ...(this.saved.bindingOverrides[`${b.component}:${b.channel}`] ?? {}) }));
    this.engine.resetAngles();
    this.inputMap.clear();
    this.defaultMaps();
    this.render();
  }

  tick(simDt: number, wallDt: number): void {
    this.engine.tick(this.host.sim(), this.host.components(), simDt, wallDt);
  }

  // ------------------------------------------------------------------ data flow

  private defaultMaps(): void {
    const traces = this.host.traces();
    const keys = new Set([...this.link.values.keys(), ...(this.link.hello?.channels.map((c) => c.key) ?? [])]);
    for (const k of keys) {
      if (this.overlayMap.has(k)) continue;
      const tr = traces.find((t) => t.hwKey === k);
      if (tr) this.overlayMap.set(k, tr.label);
    }
  }

  private sample(values: Record<string, number>): void {
    if (this.overlayMap.size === 0 && this.inputMap.size === 0) this.defaultMaps();
    const t = this.host.sim().t;
    const targets = this.inputMap.size ? this.host.inputTargets() : [];
    for (const [k, v] of Object.entries(values)) {
      const tr = this.overlayMap.get(k);
      if (tr) this.host.overlay(tr, t, v);
      const target = this.inputMap.get(k);
      if (target) targets.find((x) => x.id === target)?.apply(v);
    }
  }

  private pushStatus(): void {
    const device = !this.link.connected ? 'off' : this.link.armed ? 'armed' : this.link.mode;
    this.host.setStatus({ device, engine: this.engine.stats.connected });
  }

  private save(): void {
    this.saved.engine = { protocol: this.engine.config.protocol, url: this.engine.config.url, levelPath: this.engine.config.levelPath, rateHz: this.engine.config.rateHz };
    storage.set('ms-integrations', this.saved);
  }

  // ------------------------------------------------------------------ rendering

  private render(): void {
    if (!this.dlg.isConnected) return;
    this.valueCells.clear();
    const tabBtn = (id: 'hardware' | 'engine', label: string) => h('button', {
      className: 'tab', role: 'tab', ariaSelected: String(this.tab === id), textContent: label,
      onclick: () => { this.tab = id; this.render(); },
    });
    const head = h('header', { className: 'dlg-head' },
      h('h2', { textContent: 'Integrations' }),
      h('div', { className: 'tabs tabs-small', role: 'tablist' }, tabBtn('hardware', 'Hardware'), tabBtn('engine', 'Unreal Engine')),
      h('button', { className: 'icon-btn', ariaLabel: 'Close', onclick: () => this.dlg.close(), innerHTML: '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" stroke-width="1.6"/></svg>' }));
    const body = this.tab === 'hardware' ? this.hardwareBody() : this.engineBody();
    this.dlg.replaceChildren(head, h('div', { className: 'dlg-body dlg-pad integ' }, ...body));
  }

  private refreshValues(): void {
    for (const [k, el] of this.valueCells) {
      const v = k.startsWith('sent:') ? this.link.sent.get(k.slice(5)) : this.link.values.get(k);
      el.textContent = v === undefined ? '—' : Number(v.toPrecision(5)).toString();
    }
    if (this.tab === 'engine') {
      const sent = this.dlg.querySelector('#eng-sent');
      if (sent) sent.textContent = `${this.engine.stats.sent} messages sent`;
      const last = this.dlg.querySelector('#eng-last');
      if (last) last.textContent = this.engine.stats.last ? JSON.stringify(this.engine.stats.last, null, 2) : 'Nothing sent yet.';
    }
  }

  private hardwareBody(): HTMLElement[] {
    const L = this.link;
    const s = this.saved;
    const seg = (on: boolean, label: string, onclick: () => void, disabled = false) => h('button', { className: 'seg', ariaPressed: String(on), textContent: label, onclick, disabled });
    const out: HTMLElement[] = [];

    const conn = h('section', { className: 'integ-sec' }, h('div', { className: 'sec-label', textContent: 'Connection' }));
    if (!L.connected) {
      conn.append(h('div', { className: 'overlay-static', role: 'group', ariaLabel: 'Transport' },
        seg(s.transport === 'serial', 'USB serial', () => { s.transport = 'serial'; this.save(); this.render(); }, !serialSupported()),
        seg(s.transport === 'ws', 'WebSocket', () => { s.transport = 'ws'; this.save(); this.render(); })));
      if (s.transport === 'serial') {
        const baud = h('select', { className: 'select select-mono', id: 'hw-baud' }, ...[9600, 57600, 115200, 230400, 921600].map((b) => h('option', { value: String(b), textContent: `${b} baud`, selected: b === s.baud })));
        baud.addEventListener('change', () => { s.baud = Number(baud.value); this.save(); });
        conn.append(h('div', { className: 'row' }, h('label', { for: 'hw-baud', className: 'sr-only', textContent: 'Baud rate' }), baud));
        if (!serialSupported()) conn.append(h('p', { className: 'muted small', textContent: 'USB serial needs Chrome or Edge on a desktop. Use WebSocket for network devices.' }));
      } else {
        const url = h('input', { id: 'hw-url', className: 'text-input mono', value: s.wsUrl, spellcheck: false });
        url.addEventListener('change', () => { s.wsUrl = url.value.trim(); this.save(); });
        conn.append(h('div', { className: 'row' }, h('label', { for: 'hw-url', textContent: 'Device URL' }), url));
      }
      conn.append(h('div', { className: 'row' }, h('button', {
        className: 'btn-primary', textContent: 'Connect',
        onclick: async () => {
          try {
            await L.connect(s.transport === 'serial' ? new SerialTransport(s.baud) : new WebSocketTransport(s.wsUrl));
          } catch (e) {
            const err = e as DOMException;
            L.status = err.name === 'NotFoundError' ? 'No port was selected.' : err.message;
            this.render();
          }
        },
      }), h('span', { className: 'muted', textContent: L.status })));
    } else {
      conn.append(h('div', { className: 'row' }, h('span', { textContent: L.status }), h('span', { className: 'spacer' }),
        h('button', { className: 'btn-outline', textContent: 'Disconnect', onclick: () => void L.disconnect() })));
    }
    out.push(conn);

    if (L.connected) {
      const keys = [...new Set([...(L.hello?.channels.map((c) => c.key) ?? []), ...L.values.keys()])];
      const traces = this.host.traces();
      const targets = this.host.inputTargets();
      const table = h('table', { className: 'grid-table' },
        h('thead', {}, h('tr', {}, ...['Channel', 'Value', 'Unit', 'Draw on scope', 'Drive model input'].map((t) => h('th', { textContent: t })))),
        h('tbody', {}, ...keys.map((k) => {
          const cell = h('td', { className: 'mono' });
          this.valueCells.set(k, cell);
          const ov = h('select', { className: 'select', ariaLabel: `Scope trace for ${k}` }, h('option', { value: '', textContent: 'None' }), ...traces.map((t) => h('option', { value: t.label, textContent: t.label, selected: this.overlayMap.get(k) === t.label })));
          ov.addEventListener('change', () => { if (ov.value) this.overlayMap.set(k, ov.value); else this.overlayMap.delete(k); });
          const inp = h('select', { className: 'select', ariaLabel: `Model input driven by ${k}` }, h('option', { value: '', textContent: 'None' }), ...targets.map((t) => h('option', { value: t.id, textContent: t.label, selected: this.inputMap.get(k) === t.id })));
          inp.addEventListener('change', () => { if (inp.value) this.inputMap.set(k, inp.value); else this.inputMap.delete(k); });
          return h('tr', {}, h('td', { className: 'mono', textContent: k }), cell, h('td', { textContent: L.hello?.channels.find((c) => c.key === k)?.unit ?? '' }), h('td', {}, ov), h('td', {}, inp));
        })));
      out.push(h('section', { className: 'integ-sec' }, h('div', { className: 'sec-label', textContent: 'Channels in' }),
        keys.length ? table : h('p', { className: 'muted', textContent: 'No values yet. The device should print one line per sample.' }),
        h('p', { className: 'muted small', textContent: 'A driven input replaces that parameter with the measured value on every sample, so the twin runs with real data in the loop.' })));
    }

    if (L.connected && L.hello?.commands.length) {
      const cmd = h('section', { className: 'integ-sec' }, h('div', { className: 'sec-label', textContent: 'Commands out' }),
        h('div', { className: 'overlay-static', role: 'group', ariaLabel: 'Mode' },
          seg(L.mode === 'observe', 'Observe', () => L.setMode('observe')),
          seg(L.mode === 'assisted', 'Assisted', () => L.setMode('assisted'))));
      if (L.mode === 'assisted') {
        const box = h('div', { className: 'hazard-box' }, h('strong', { textContent: 'Commands move real hardware.' }),
          h('p', { textContent: `Every setpoint is checked against the range the device declared and ramped at its rate limit. Studio sends a heartbeat every 200 ms; if it stops, the device returns to its safe values within ${L.hello.watchdogMs} ms. Your hardware stop must not depend on this link.` }));
        if (!L.armed) {
          const cb = h('input', { type: 'checkbox', id: 'hw-reach', checked: this.stopReach });
          cb.addEventListener('change', () => { this.stopReach = cb.checked; this.render(); });
          box.append(h('div', { className: 'row' }, cb, h('label', { for: 'hw-reach', textContent: 'The hardware stop is within reach' })),
            h('button', { className: 'btn-hazard', textContent: 'Arm', disabled: !this.stopReach, onclick: () => { const err = this.link.arm(); if (err) toast(err, 'error'); } }));
        } else {
          box.append(h('div', { className: 'row' }, h('span', { className: 'armed-dot' }), h('strong', { textContent: 'Armed' }), h('span', { className: 'spacer' }),
            h('button', { className: 'btn-hazard', textContent: 'Disarm', onclick: () => void this.link.disarm('Disarmed by you.') })));
        }
        cmd.append(box);
      }
      cmd.append(h('table', { className: 'grid-table' },
        h('thead', {}, h('tr', {}, ...['Command', 'Range', 'Rate', 'Safe', 'Sent', 'Setpoint'].map((t) => h('th', { textContent: t })))),
        h('tbody', {}, ...L.hello.commands.map((c) => {
          const sent = h('td', { className: 'mono' });
          this.valueCells.set(`sent:${c.key}`, sent);
          const input = h('input', { className: 'text-input mono', value: String(L.target.get(c.key) ?? c.safe), ariaLabel: `Setpoint for ${c.key}`, disabled: !L.armed, inputMode: 'decimal' });
          const go = () => { const err = L.request(c.key, Number(input.value)); if (err) toast(err, 'error'); else toast(`${c.key} ramping to ${input.value}${c.unit ? ` ${c.unit}` : ''}.`); };
          input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
          return h('tr', {},
            h('td', { className: 'mono', textContent: c.key }),
            h('td', { className: 'mono', textContent: `${c.min} – ${c.max}${c.unit ? ` ${c.unit}` : ''}` }),
            h('td', { className: 'mono', textContent: `${c.rate}/s` }),
            h('td', { className: 'mono', textContent: String(c.safe) }),
            sent,
            h('td', {}, h('div', { className: 'row' }, input, h('button', { className: 'btn-outline btn-small', textContent: 'Set', disabled: !L.armed, onclick: go }))));
        }))));
      out.push(cmd);
    }

    out.push(h('section', { className: 'integ-sec' }, h('div', { className: 'sec-label', textContent: 'Protocol' }),
      h('p', { className: 'muted small', textContent: 'EMS Link v1: one JSON object per line. Devices send {"hello":…}, {"v":{"rpm":871}} and {"ack":seq}; Studio sends {"cmd":{…},"seq":n,"ttl":600}, {"hb":n} and {"disarm":true}. Plain rpm:871 lines also work, read only. See docs/EMS-LINK.md and the Arduino and fake-device examples.' })));
    return out;
  }

  private engineBody(): HTMLElement[] {
    const E = this.engine;
    const c = E.config;
    const out: HTMLElement[] = [];
    const seg = (on: boolean, label: string, p: EngineProtocol) => h('button', {
      className: 'seg', ariaPressed: String(on), textContent: label, disabled: E.stats.connected,
      onclick: () => { c.protocol = p; c.url = p === 'remote-control' ? 'ws://127.0.0.1:30020' : 'ws://localhost:8770'; this.save(); this.render(); },
    });
    const url = h('input', { id: 'eng-url', className: 'text-input mono', value: c.url, spellcheck: false, disabled: E.stats.connected });
    url.addEventListener('change', () => { c.url = url.value.trim(); this.save(); });
    const level = h('input', { id: 'eng-level', className: 'text-input mono', value: c.levelPath, spellcheck: false });
    level.addEventListener('change', () => { c.levelPath = level.value.trim(); this.save(); });
    const rate = h('select', { id: 'eng-rate', className: 'select select-mono' }, ...[10, 20, 30, 60].map((r) => h('option', { value: String(r), textContent: `${r} Hz`, selected: r === c.rateHz })));
    rate.addEventListener('change', () => { c.rateHz = Number(rate.value); this.save(); });

    out.push(h('section', { className: 'integ-sec' }, h('div', { className: 'sec-label', textContent: 'Connection' }),
      h('div', { className: 'overlay-static', role: 'group', ariaLabel: 'Protocol' }, seg(c.protocol === 'remote-control', 'Unreal Remote Control API', 'remote-control'), seg(c.protocol === 'twin-stream', 'Twin Stream JSON', 'twin-stream')),
      h('div', { className: 'form-grid' },
        h('label', { for: 'eng-url', textContent: 'WebSocket URL' }), url,
        ...(c.protocol === 'remote-control' ? [h('label', { for: 'eng-level', textContent: 'Level path' }), level] : []),
        h('label', { for: 'eng-rate', textContent: 'Update rate' }), rate),
      h('div', { className: 'row' },
        E.stats.connected
          ? h('button', { className: 'btn-outline', textContent: 'Stop streaming', onclick: () => E.disconnect() })
          : h('button', { className: 'btn-primary', textContent: 'Start streaming', onclick: async () => { try { await E.connect(); } catch (e) { E.stats.status = (e as Error).message; this.render(); } } }),
        h('span', { className: 'muted', textContent: E.stats.status }), h('span', { className: 'spacer' }), h('span', { id: 'eng-sent', className: 'mono muted', textContent: `${E.stats.sent} messages sent` }))));

    const comps = this.host.components();
    const table = h('table', { className: 'grid-table' },
      h('thead', {}, h('tr', {}, ...['Send', 'Part · channel', 'Actor', 'Property'].map((t) => h('th', { textContent: t })))),
      h('tbody', {}, ...c.bindings.map((b) => {
        const key = `${b.component}:${b.channel}`;
        const ch = channelsFor(comps.find((x) => x.id === b.component)!).find((x) => x.key === b.channel);
        const o = (this.saved.bindingOverrides[key] ??= {});
        const en = h('input', { type: 'checkbox', checked: b.enabled, ariaLabel: `Send ${key}` });
        en.addEventListener('change', () => { b.enabled = en.checked; o.enabled = en.checked; this.save(); });
        const actor = h('input', { className: 'text-input mono', value: b.actor, ariaLabel: `Actor for ${key}`, spellcheck: false });
        actor.addEventListener('change', () => { b.actor = actor.value.trim(); o.actor = b.actor; this.save(); });
        const prop = h('input', { className: 'text-input mono', value: b.property, ariaLabel: `Property for ${key}`, spellcheck: false });
        prop.addEventListener('change', () => { b.property = prop.value.trim(); o.property = b.property; this.save(); });
        return h('tr', {}, h('td', {}, en), h('td', {}, h('span', { className: 'mono', textContent: b.component }), ` ${ch?.label ?? b.channel} (${ch?.unit ?? ''})`), h('td', {}, actor), h('td', {}, prop));
      })));
    out.push(h('section', { className: 'integ-sec' }, h('div', { className: 'sec-label', textContent: `Bindings · ${this.host.sceneName()}` }),
      h('div', { className: 'table-scroll' }, table)));

    out.push(h('section', { className: 'integ-sec' }, h('div', { className: 'sec-label', textContent: 'Last message' }),
      h('pre', { id: 'eng-last', className: 'code-pre', textContent: E.stats.last ? JSON.stringify(E.stats.last, null, 2) : 'Nothing sent yet.' })));

    out.push(h('section', { className: 'integ-sec' }, h('div', { className: 'sec-label', textContent: 'Geometry' }),
      h('div', { className: 'row' }, h('button', {
        className: 'btn-outline', textContent: 'Download glTF (.glb)',
        onclick: async () => {
          try { download(`${this.host.sceneName().replace(/[^\w-]+/g, '-').toLowerCase()}.glb`, await this.host.exportGLB(), 'model/gltf-binary'); }
          catch (e) { toast(`Export failed: ${(e as Error).message}`, 'error'); }
        },
      }), h('span', { className: 'muted small', textContent: 'Import into Unreal with File › Import Into Level. Each part becomes an actor named by its id, matching the bindings above.' }))));

    out.push(h('details', { className: 'integ-sec setup' }, h('summary', { textContent: 'Setting up Unreal Engine' }),
      h('ol', {},
        h('li', { textContent: 'Enable the Remote Control API plugin (Edit › Plugins), restart the editor, and make sure its WebSocket server is running (default port 30020).' }),
        h('li', { textContent: 'Import the .glb, or build your own actors. Name each actor like the part id (M1, F1…) or change the Actor column.' }),
        h('li', { textContent: 'Give each actor Blueprint a float variable per bound property (for example EMS_shaft_angle), set it Instance Editable, and use it in the Blueprint, such as Set Relative Rotation on the rotor each tick.' }),
        h('li', { textContent: 'Copy the level path from the Outliner (right-click the level › Copy Reference) and keep the :PersistentLevel suffix.' }),
        h('li', { textContent: 'Press Start streaming. Rejected writes show up in the status line.' })),
      h('p', { className: 'muted small', textContent: 'Messages follow the Remote Control API documentation; check them against your engine version with the Last message preview. Twin Stream JSON sends one frame per update for a custom plugin, Unity, Omniverse or any WebSocket listener.' })));
    return out;
  }
}
