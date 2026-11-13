import { type CommandInfo, encodeCommand, encodeDisarm, encodeHeartbeat, encodeHello, type Hello, type Incoming, parseLine } from './protocol';
import type { Transport } from './transports';

export type LinkMode = 'observe' | 'assisted';

export interface LinkEvents {
  onSample(values: Record<string, number>): void;
  onHello(hello: Hello): void;
  onLog(line: string): void;
  onState(): void;
}

/** How often commands or heartbeats go out while armed. */
export const TICK_MS = 200;

/**
 * One device connection. Reading is always allowed. Writing needs Assisted mode, an explicit arm,
 * a setpoint inside the device's declared range, and goes out as a ramp that respects the
 * device's rate limit. Every tick carries a short time-to-live; a device that misses heartbeats
 * for its watchdog period returns to its safe values on its own.
 */
export class DeviceLink {
  hello: Hello | null = null;
  readonly values = new Map<string, number>();
  mode: LinkMode = 'observe';
  armed = false;
  connected = false;
  status = 'Not connected.';
  /** Where each command is heading, and what was last sent. */
  readonly target = new Map<string, number>();
  readonly sent = new Map<string, number>();
  lastAck = 0;
  private seq = 0;
  private unacked = 0;
  private timer = 0;
  private transport: Transport | null = null;

  constructor(private readonly ev: LinkEvents) {}

  get label(): string { return this.transport?.label ?? ''; }

  async connect(t: Transport): Promise<void> {
    await this.disconnect();
    this.transport = t;
    await t.open((line) => this.receive(line), (reason) => this.closed(reason));
    this.connected = true;
    this.status = `Connected · ${t.label}. Waiting for the device to introduce itself.`;
    this.ev.onLog(`# connected over ${t.label}`);
    try { await t.send(encodeHello()); } catch { /* read-only port */ }
    this.ev.onState();
  }

  async disconnect(): Promise<void> {
    if (this.armed) await this.disarm('Disconnecting.');
    const t = this.transport;
    this.transport = null;
    if (t) await t.close();
    this.closed('Disconnected.');
  }

  setMode(m: LinkMode): void {
    if (m === 'observe' && this.armed) void this.disarm('Switched to Observe.');
    this.mode = m;
    this.ev.onState();
  }

  /** Start sending. Returns a reason when arming is not allowed. */
  arm(): string | null {
    if (!this.connected) return 'Connect a device first.';
    if (this.mode !== 'assisted') return 'Switch to Assisted mode to send commands.';
    if (!this.hello?.commands.length) return 'This device declared no commands, so there is nothing to send.';
    for (const c of this.hello.commands) {
      const now = this.values.get(c.key);
      const start = now !== undefined && now >= c.min && now <= c.max ? now : c.safe;
      this.sent.set(c.key, start);
      this.target.set(c.key, start);
    }
    this.armed = true;
    this.unacked = 0;
    this.ev.onLog('# armed: commands and heartbeats every 200 ms');
    this.timer = window.setInterval(() => void this.tick(), TICK_MS);
    this.ev.onState();
    return null;
  }

  async disarm(reason: string): Promise<void> {
    if (!this.armed) return;
    this.armed = false;
    window.clearInterval(this.timer);
    this.ev.onLog(`# disarmed: ${reason}`);
    try { await this.transport?.send(encodeDisarm()); } catch { /* link already gone */ }
    this.ev.onState();
  }

  /** Validate a requested setpoint. The ramp toward it happens on the next ticks. */
  request(key: string, value: number): string | null {
    const c = this.command(key);
    if (!c) return `The device has no command named ${key}.`;
    if (!Number.isFinite(value)) return 'Enter a number.';
    if (value < c.min || value > c.max) return `Outside the device's range: ${c.min} to ${c.max}${c.unit ? ` ${c.unit}` : ''}.`;
    if (!this.armed) return 'Arm the link first.';
    this.target.set(key, value);
    return null;
  }

  command(key: string): CommandInfo | undefined {
    return this.hello?.commands.find((c) => c.key === key);
  }

  private async tick(): Promise<void> {
    if (!this.armed || !this.transport || !this.hello) return;
    if (this.unacked >= 5) { await this.disarm('The device stopped acknowledging commands.'); this.status = 'Disarmed: no acknowledgements from the device.'; return; }
    const out: Record<string, number> = {};
    for (const c of this.hello.commands) {
      const from = this.sent.get(c.key) ?? c.safe;
      const to = this.target.get(c.key) ?? from;
      const step = (c.rate * TICK_MS) / 1000;
      const next = Math.abs(to - from) <= step ? to : from + Math.sign(to - from) * step;
      if (next !== from) out[c.key] = next;
      this.sent.set(c.key, next);
    }
    this.seq++;
    try {
      if (Object.keys(out).length) {
        await this.transport.send(encodeCommand(this.seq, out, TICK_MS * 3));
        this.ev.onLog(`> cmd ${JSON.stringify(out)} seq ${this.seq}`);
      } else {
        await this.transport.send(encodeHeartbeat(this.seq));
      }
      this.unacked++;
    } catch (err) {
      await this.disarm(`Send failed: ${(err as Error).message}`);
    }
  }

  private receive(line: string): void {
    const msg: Incoming = parseLine(line);
    switch (msg.kind) {
      case 'hello':
        this.hello = msg.hello;
        this.status = `${msg.hello.device}${msg.hello.firmware ? ` · ${msg.hello.firmware}` : ''} · ${msg.hello.channels.length} channels · ${msg.hello.commands.length} commands`;
        this.ev.onLog(`< hello ${msg.hello.device}`);
        this.ev.onHello(msg.hello);
        this.ev.onState();
        break;
      case 'telemetry':
        for (const [k, v] of Object.entries(msg.values)) this.values.set(k, v);
        if (!this.hello) this.status = `Receiving ${Object.keys(msg.values).join(', ')} (plain key:value lines, read only).`;
        this.ev.onSample(msg.values);
        this.ev.onLog(`< ${line}`);
        break;
      case 'ack':
        this.unacked = 0;
        this.lastAck = msg.seq;
        if (!msg.ok) this.ev.onLog(`< rejected seq ${msg.seq}: ${msg.reason}`);
        break;
      case 'event':
        this.ev.onLog(`< ${msg.level === 'warn' ? 'WARN ' : ''}${msg.text}`);
        if (msg.level === 'warn' && this.armed && /watchdog|safe/i.test(msg.text)) void this.disarm(`Device: ${msg.text}`);
        break;
      default:
        this.ev.onLog(`< ${line}`);
    }
  }

  private closed(reason: string): void {
    if (this.armed) { this.armed = false; window.clearInterval(this.timer); }
    if (!this.connected && !this.transport) { this.ev.onState(); return; }
    this.connected = false;
    this.transport = null;
    this.status = reason;
    this.ev.onLog(`# ${reason}`);
    this.ev.onState();
  }
}
