// A simulated motor rig that speaks EMS Link v1 over WebSocket, for trying the hardware link
// without hardware.   node tools/fake-device.mjs   then connect Studio to ws://localhost:8765
// It honours the same safety rules a real device must: range checks, a rate limit and a watchdog.
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT ?? 8765);
const PWM = { key: 'pwm', min: 0, max: 255, rate: 120, safe: 0, unit: 'duty' };
const WATCHDOG_MS = 1000;
const s = { pwm: 0, rpm: 0, current: 0, temp: 22, lastLife: 0, live: false, clients: 0, acks: 0, rejected: 0, trips: 0 };
const log = [];
const note = (line) => { log.push(`${new Date().toISOString().slice(11, 23)}  ${line}`); if (log.length > 40) log.shift(); };

const hello = {
  hello: {
    device: 'fake-motor-rig', firmware: 'ems-link/1 simulator', watchdog_ms: WATCHDOG_MS,
    channels: [{ key: 'rpm', unit: 'rpm' }, { key: 'current', unit: 'A' }, { key: 'temp', unit: '°C' }, { key: 'pwm', unit: 'duty' }],
    commands: [PWM],
  },
};

// Motor physics at 100 Hz: first-order speed response, current from back-EMF, winding heating.
setInterval(() => {
  const dt = 0.01;
  const target = (s.pwm / 255) * 3000;
  s.rpm += ((target - s.rpm) * dt) / 0.35;
  s.current = Math.max(0, 0.08 + 1.6 * (s.pwm / 255) * (1 - s.rpm / 3300));
  s.temp += ((s.current * s.current * 2.4 - (s.temp - 22) / 18) * dt) / 4.2;
  if (s.live && s.pwm !== PWM.safe && Date.now() - s.lastLife > WATCHDOG_MS) {
    s.pwm = PWM.safe;
    s.live = false;
    s.trips++;
    note('WATCHDOG: no command or heartbeat for 1 s, pwm -> 0');
    broadcast({ event: 'watchdog: no heartbeat for 1 s, returned to safe values', level: 'warn' });
  }
}, 10);

const server = createServer((req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><meta http-equiv="refresh" content="1"><title>Fake motor rig</title>
<body style="font:14px/1.5 ui-monospace,monospace;background:#0A1622;color:#E3EBF3;padding:20px">
<h1 style="font:600 18px system-ui">Fake motor rig · ws://localhost:${PORT}</h1>
<p>clients ${s.clients} · pwm ${s.pwm.toFixed(1)} · rpm ${s.rpm.toFixed(0)} · current ${s.current.toFixed(3)} A · temp ${s.temp.toFixed(2)} °C</p>
<p>acks ${s.acks} · rejected ${s.rejected} · watchdog trips ${s.trips}</p>
<pre id="log">${log.join('\n')}</pre></body>`);
});
const wss = new WebSocketServer({ server });

function broadcast(obj) {
  const text = JSON.stringify(obj);
  for (const c of wss.clients) if (c.readyState === 1) c.send(text);
}

wss.on('connection', (ws) => {
  s.clients++;
  note('client connected');
  ws.send(JSON.stringify(hello));
  const telemetry = setInterval(() => {
    ws.send(JSON.stringify({ v: { rpm: +s.rpm.toFixed(1), current: +s.current.toFixed(4), temp: +s.temp.toFixed(3), pwm: +s.pwm.toFixed(2) } }));
  }, 20);
  ws.on('message', (data) => {
    for (const line of String(data).split('\n').filter(Boolean)) {
      let m;
      try { m = JSON.parse(line); } catch { note(`bad line: ${line}`); continue; }
      if (m.hello) { ws.send(JSON.stringify(hello)); continue; }
      if (m.disarm) { s.pwm = PWM.safe; s.live = false; note('disarm -> pwm 0'); ws.send(JSON.stringify({ event: 'disarmed, pwm at safe value' })); continue; }
      if (typeof m.hb === 'number') { s.lastLife = Date.now(); s.live = true; s.acks++; ws.send(JSON.stringify({ ack: m.hb })); continue; }
      if (m.cmd && typeof m.seq === 'number') {
        const v = m.cmd.pwm;
        if (typeof v !== 'number' || v < PWM.min || v > PWM.max) {
          s.rejected++;
          ws.send(JSON.stringify({ ack: m.seq, ok: false, reason: 'pwm out of range' }));
          continue;
        }
        if (Math.abs(v - s.pwm) > PWM.rate * 0.3 + 1e-9) {
          s.rejected++;
          note(`rejected step ${s.pwm.toFixed(1)} -> ${v} (faster than ${PWM.rate}/s)`);
          ws.send(JSON.stringify({ ack: m.seq, ok: false, reason: 'change faster than rate limit' }));
          continue;
        }
        s.pwm = v;
        s.lastLife = Date.now();
        s.live = true;
        s.acks++;
        note(`cmd pwm=${v.toFixed(1)} seq ${m.seq}`);
        ws.send(JSON.stringify({ ack: m.seq }));
      }
    }
  });
  ws.on('close', () => { clearInterval(telemetry); s.clients--; note('client disconnected'); });
});

server.listen(PORT, () => console.log(`fake-motor-rig on ws://localhost:${PORT} (status page http://localhost:${PORT})`));
