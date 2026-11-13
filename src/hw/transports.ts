/** A line-oriented byte pipe to a device. */
export interface Transport {
  readonly label: string;
  open(onLine: (line: string) => void, onClose: (reason: string) => void): Promise<void>;
  send(text: string): Promise<void>;
  close(): Promise<void>;
}

interface SerialPortLike {
  open(o: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
}

export const serialSupported = () => typeof navigator !== 'undefined' && 'serial' in navigator;

function lineSplitter(onLine: (l: string) => void) {
  let buf = '';
  return (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) onLine(line);
    }
    if (buf.length > 65536) buf = '';
  };
}

/** USB serial via Web Serial (Chrome and Edge on desktop). */
export class SerialTransport implements Transport {
  readonly label: string;
  private port?: SerialPortLike;
  private reader?: ReadableStreamDefaultReader<string>;
  private writer?: WritableStreamDefaultWriter<Uint8Array>;
  private closing = false;

  constructor(private readonly baudRate = 115200) {
    this.label = `USB serial · ${baudRate} baud`;
  }

  async open(onLine: (line: string) => void, onClose: (reason: string) => void): Promise<void> {
    const serial = (navigator as unknown as { serial: { requestPort(): Promise<SerialPortLike> } }).serial;
    this.port = await serial.requestPort();
    await this.port.open({ baudRate: this.baudRate });
    this.closing = false;
    const decoder = new TextDecoderStream();
    this.port.readable!.pipeTo(decoder.writable as WritableStream<Uint8Array>).catch(() => {});
    this.reader = decoder.readable.getReader();
    this.writer = this.port.writable?.getWriter();
    const feed = lineSplitter(onLine);
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await this.reader!.read();
          if (done) break;
          feed(value);
        }
        onClose(this.closing ? 'Disconnected.' : 'The device stopped sending.');
      } catch (err) {
        onClose(this.closing ? 'Disconnected.' : `Connection lost: ${(err as Error).message}`);
      }
    })();
  }

  async send(text: string): Promise<void> {
    if (!this.writer) throw new Error('This port is read-only.');
    await this.writer.write(new TextEncoder().encode(text));
  }

  async close(): Promise<void> {
    this.closing = true;
    try { await this.reader?.cancel(); } catch { /* closed */ }
    try { this.writer?.releaseLock(); } catch { /* closed */ }
    try { await this.port?.close(); } catch { /* closed */ }
    this.port = undefined;
  }
}

/** Network devices (ESP32, Raspberry Pi, a ROS 2 or Node-RED bridge) over a WebSocket. */
export class WebSocketTransport implements Transport {
  readonly label: string;
  private ws?: WebSocket;
  private closing = false;

  constructor(private readonly url: string) {
    this.label = `WebSocket · ${url}`;
  }

  open(onLine: (line: string) => void, onClose: (reason: string) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      let opened = false;
      const ws = new WebSocket(this.url);
      this.ws = ws;
      this.closing = false;
      const feed = lineSplitter(onLine);
      ws.onopen = () => { opened = true; resolve(); };
      ws.onmessage = (ev) => feed(typeof ev.data === 'string' ? (ev.data.endsWith('\n') ? ev.data : `${ev.data}\n`) : '');
      ws.onerror = () => { if (!opened) reject(new Error(`Could not connect to ${this.url}.`)); };
      ws.onclose = (ev) => {
        if (!opened) return;
        onClose(this.closing ? 'Disconnected.' : `Connection closed${ev.reason ? `: ${ev.reason}` : ''}.`);
      };
    });
  }

  async send(text: string): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('Not connected.');
    for (const line of text.split('\n').filter(Boolean)) this.ws.send(line);
  }

  async close(): Promise<void> {
    this.closing = true;
    this.ws?.close();
    this.ws = undefined;
  }
}
