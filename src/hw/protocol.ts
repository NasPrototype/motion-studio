/**
 * EMS Link v1: newline-delimited JSON between a device and Motion Studio, over USB serial or a
 * WebSocket. Full description in docs/EMS-LINK.md. Plain `key:value,key:value` lines are accepted
 * as telemetry so a five-line Arduino sketch still works.
 */

export interface ChannelInfo {
  key: string;
  unit: string;
}

export interface CommandInfo {
  key: string;
  min: number;
  max: number;
  /** Largest change the device accepts per second. */
  rate: number;
  /** Value the device falls back to when the watchdog trips or Studio disarms. */
  safe: number;
  unit: string;
}

export interface Hello {
  device: string;
  firmware: string;
  channels: ChannelInfo[];
  commands: CommandInfo[];
  /** The device returns every command to `safe` if no command or heartbeat arrives for this long. */
  watchdogMs: number;
}

export type Incoming =
  | { kind: 'hello'; hello: Hello }
  | { kind: 'telemetry'; values: Record<string, number> }
  | { kind: 'ack'; seq: number; ok: boolean; reason: string }
  | { kind: 'event'; level: 'info' | 'warn'; text: string }
  | { kind: 'unknown'; raw: string };

const str = (v: unknown, d = '') => (typeof v === 'string' ? v : d);
const fin = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export function parseLine(raw: string): Incoming {
  const line = raw.trim();
  if (line.startsWith('{')) {
    let o: Record<string, unknown>;
    try { o = JSON.parse(line); } catch { return { kind: 'unknown', raw: line }; }
    if (o.hello && typeof o.hello === 'object') {
      const h = o.hello as Record<string, unknown>;
      return {
        kind: 'hello',
        hello: {
          device: str(h.device, 'device'),
          firmware: str(h.firmware),
          watchdogMs: Math.max(100, fin(h.watchdog_ms, 1000)),
          channels: (Array.isArray(h.channels) ? h.channels : []).map((c) => typeof c === 'string' ? { key: c, unit: '' } : { key: str((c as Record<string, unknown>).key), unit: str((c as Record<string, unknown>).unit) }).filter((c) => c.key),
          commands: (Array.isArray(h.commands) ? h.commands : []).flatMap((c) => {
            const q = c as Record<string, unknown>;
            const min = fin(q.min, NaN), max = fin(q.max, NaN);
            if (!str(q.key) || !(max > min)) return [];
            const safe = Math.min(max, Math.max(min, fin(q.safe, min)));
            return [{ key: str(q.key), min, max, rate: Math.max(0, fin(q.rate, max - min)), safe, unit: str(q.unit) }];
          }),
        },
      };
    }
    if (o.v && typeof o.v === 'object') {
      const values: Record<string, number> = {};
      for (const [k, v] of Object.entries(o.v as Record<string, unknown>)) if (typeof v === 'number' && Number.isFinite(v)) values[k] = v;
      return { kind: 'telemetry', values };
    }
    if (typeof o.ack === 'number') return { kind: 'ack', seq: o.ack, ok: o.ok !== false, reason: str(o.reason) };
    if (typeof o.event === 'string') return { kind: 'event', level: o.level === 'warn' ? 'warn' : 'info', text: o.event };
    return { kind: 'unknown', raw: line };
  }
  const values: Record<string, number> = {};
  for (const part of line.split(/[,\s]+/)) {
    const m = part.match(/^([A-Za-z_][\w.]*)[:=](-?\d+(?:\.\d+)?(?:e-?\d+)?)$/i);
    if (m) values[m[1]] = Number(m[2]);
  }
  return Object.keys(values).length ? { kind: 'telemetry', values } : { kind: 'unknown', raw: line };
}

export const encodeCommand = (seq: number, values: Record<string, number>, ttlMs: number) => `${JSON.stringify({ cmd: values, seq, ttl: ttlMs })}\n`;
export const encodeHeartbeat = (seq: number) => `${JSON.stringify({ hb: seq })}\n`;
export const encodeDisarm = () => `${JSON.stringify({ disarm: true })}\n`;
export const encodeHello = () => `${JSON.stringify({ hello: { host: 'motion-studio', protocol: 'ems-link/1' } })}\n`;
