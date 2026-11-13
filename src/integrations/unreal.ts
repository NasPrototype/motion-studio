import type { Simulator } from '../sim/core';
import type { Component } from '../sim/components';

/**
 * Live sync from the Studio's simulation to an engine.
 *
 * - "remote-control": Unreal Engine's Remote Control API over its WebSocket server
 *   (default ws://127.0.0.1:30020). Each update writes a property on an actor in the open level.
 * - "twin-stream": one JSON frame per update with every bound channel, for a custom Unreal plugin,
 *   Unity, Omniverse or any WebSocket listener. Format in docs/EMS-LINK.md.
 */
export type EngineProtocol = 'remote-control' | 'twin-stream';

export interface Channel {
  key: string;
  label: string;
  unit: string;
  /** Rotation angles are integrated here from angular velocity, so they are continuous. */
  integrate?: boolean;
  get(sim: Simulator): number;
}

export interface Binding {
  component: string;
  channel: string;
  actor: string;
  property: string;
  enabled: boolean;
}

export interface EngineConfig {
  protocol: EngineProtocol;
  url: string;
  /** Unreal object path of the level, e.g. /Game/Maps/Studio.Studio:PersistentLevel */
  levelPath: string;
  rateHz: number;
  bindings: Binding[];
}

const TAU = Math.PI * 2;

/** Channels worth sending for a component, from its ports. */
export function channelsFor(c: Component): Channel[] {
  const out: Channel[] = [];
  for (const p of c.ports) {
    if (p.node < 0) continue;
    if (p.domain === 'rotational') {
      out.push({ key: `${p.name}.angle`, label: `${p.name} angle`, unit: 'deg', integrate: true, get: (s) => (s.effort(p.node) * 180) / Math.PI });
      out.push({ key: `${p.name}.rpm`, label: `${p.name} speed`, unit: 'rpm', get: (s) => (s.effort(p.node) * 60) / TAU });
    } else if (p.domain === 'thermal') {
      out.push({ key: `${p.name}.tempC`, label: `${p.name} temperature`, unit: '°C', get: (s) => s.effort(p.node) - 273.15 });
    } else {
      out.push({ key: `${p.name}.volts`, label: `${p.name} voltage`, unit: 'V', get: (s) => s.effort(p.node) });
    }
  }
  if (c.type.includes('led')) out.push({ key: 'brightness', label: 'brightness', unit: '0–1', get: () => Math.min(1, Math.max(0, c.elements[0].flows[0] / 0.02)) });
  if (c.type.includes('switch')) out.push({ key: 'closed', label: 'closed', unit: '0/1', get: () => ((c as Component & { state?: { closed: boolean } }).state?.closed ? 1 : 0) });
  return out;
}

/** UE property name used by default, e.g. shaft.angle → EMS_shaft_angle. */
export const defaultProperty = (channel: string) => `EMS_${channel.replace(/[^A-Za-z0-9]+/g, '_')}`;

/** One Remote Control "set property" call wrapped for the WebSocket server. */
export function rcSetProperty(levelPath: string, actor: string, property: string, value: number, requestId: number) {
  return {
    MessageName: 'http',
    Parameters: {
      RequestId: requestId,
      Url: '/remote/object/property',
      Verb: 'PUT',
      Body: {
        objectPath: `${levelPath}.${actor}`,
        access: 'WRITE_ACCESS',
        propertyName: property,
        propertyValue: { [property]: value },
      },
    },
  };
}

export function twinFrame(t: number, values: Record<string, Record<string, number>>) {
  return { type: 'ems.frame', version: 1, t, parts: values };
}

export interface EngineStats {
  connected: boolean;
  sent: number;
  status: string;
  last: unknown;
}

export class EngineLink {
  stats: EngineStats = { connected: false, sent: 0, status: 'Not connected.', last: null };
  private ws?: WebSocket;
  private acc = 0;
  private angles = new Map<string, number>();
  private requestId = 0;

  constructor(public config: EngineConfig, private readonly onChange: () => void) {}

  connect(): Promise<void> {
    this.disconnect();
    return new Promise((resolve, reject) => {
      let opened = false;
      const ws = new WebSocket(this.config.url);
      this.ws = ws;
      ws.onopen = () => {
        opened = true;
        this.stats = { ...this.stats, connected: true, status: `Streaming to ${this.config.url} at ${this.config.rateHz} Hz.` };
        this.onChange();
        resolve();
      };
      ws.onerror = () => { if (!opened) reject(new Error(`Could not connect to ${this.config.url}. Is the engine running with its WebSocket server on?`)); };
      ws.onclose = () => {
        if (this.ws !== ws) return;
        this.ws = undefined;
        this.stats = { ...this.stats, connected: false, status: opened ? 'The engine closed the connection.' : this.stats.status };
        this.onChange();
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string' && /"ResponseCode"\s*:\s*4\d\d/.test(ev.data)) {
          this.stats.status = 'Unreal rejected a property write. Check the level path, actor names and property names.';
          this.onChange();
        }
      };
    });
  }

  disconnect(): void {
    const ws = this.ws;
    this.ws = undefined;
    ws?.close();
    if (this.stats.connected) { this.stats = { ...this.stats, connected: false, status: 'Stopped.' }; this.onChange(); }
  }

  resetAngles(): void { this.angles.clear(); }

  /** Call every frame with the simulated time that passed. Sends at most `rateHz` updates a second. */
  tick(sim: Simulator, components: Component[], simDt: number, wallDt: number): void {
    const enabled = this.config.bindings.filter((b) => b.enabled);
    const byComp = new Map(components.map((c) => [c.id, c]));
    // Integrate angles every frame so nothing is lost between sends.
    for (const b of enabled) {
      const ch = byComp.get(b.component) && channelsFor(byComp.get(b.component)!).find((x) => x.key === b.channel);
      if (ch?.integrate) {
        const k = `${b.component}:${b.channel}`;
        this.angles.set(k, ((this.angles.get(k) ?? 0) + ch.get(sim) * simDt) % 360);
      }
    }
    this.acc += wallDt;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.acc < 1 / this.config.rateHz) return;
    this.acc = 0;
    if (this.ws.bufferedAmount > 256 * 1024) { this.stats.status = 'The engine is not keeping up; skipping updates.'; return; }

    const frame: Record<string, Record<string, number>> = {};
    for (const b of enabled) {
      const c = byComp.get(b.component);
      const ch = c && channelsFor(c).find((x) => x.key === b.channel);
      if (!ch) continue;
      const value = ch.integrate ? this.angles.get(`${b.component}:${b.channel}`) ?? 0 : ch.get(sim);
      const v = Number.isFinite(value) ? Number(value.toFixed(5)) : 0;
      if (this.config.protocol === 'remote-control') {
        const msg = rcSetProperty(this.config.levelPath, b.actor, b.property, v, ++this.requestId);
        this.ws.send(JSON.stringify(msg));
        this.stats.sent++;
        this.stats.last = msg;
      } else {
        (frame[b.actor] ??= {})[b.property] = v;
      }
    }
    if (this.config.protocol === 'twin-stream' && Object.keys(frame).length) {
      const msg = twinFrame(Number(sim.t.toFixed(4)), frame);
      this.ws.send(JSON.stringify(msg));
      this.stats.sent++;
      this.stats.last = msg;
    }
  }
}

/** Bindings for every channel of every component, enabled for rotation and brightness by default. */
export function defaultBindings(components: Component[]): Binding[] {
  return components.flatMap((c) => channelsFor(c).map((ch) => ({
    component: c.id,
    channel: ch.key,
    actor: c.id,
    property: defaultProperty(ch.key),
    enabled: ch.integrate === true || ch.key === 'brightness' || ch.key === 'closed',
  })));
}
