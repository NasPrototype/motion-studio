// A stand-in for an engine's WebSocket endpoint. It accepts Unreal Remote Control API messages
// and EMS Twin Stream frames, checks their shape, and shows what arrived on a status page.
//   node tools/mock-engine.mjs        (port 30020, Unreal's Remote Control default)
// It is a format check only; a real Unreal Editor is the final test.
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT ?? 30020);
const stats = { connections: 0, rc: 0, frames: 0, invalid: 0, last: null, problems: [], actors: {} };

function checkRc(m) {
  const p = m.Parameters ?? {};
  const b = p.Body ?? {};
  const errs = [];
  if (m.MessageName !== 'http') errs.push('MessageName should be "http"');
  if (p.Url !== '/remote/object/property') errs.push('Url should be /remote/object/property');
  if (p.Verb !== 'PUT') errs.push('Verb should be PUT');
  if (typeof b.objectPath !== 'string' || !b.objectPath.includes(':PersistentLevel.')) errs.push('objectPath should look like /Game/Map.Map:PersistentLevel.Actor');
  if (typeof b.propertyName !== 'string') errs.push('propertyName missing');
  if (!b.propertyValue || !(b.propertyName in b.propertyValue)) errs.push('propertyValue should be keyed by propertyName');
  return errs;
}

const server = createServer((req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  const actors = Object.entries(stats.actors).map(([k, v]) => `${k.padEnd(40)} ${v}`).join('\n');
  res.end(`<!doctype html><meta http-equiv="refresh" content="1"><title>Mock engine</title>
<body style="font:14px/1.5 ui-monospace,monospace;background:#0A1622;color:#E3EBF3;padding:20px">
<h1 style="font:600 18px system-ui">Mock engine · ws://127.0.0.1:${PORT}</h1>
<p>connections ${stats.connections} · remote-control writes ${stats.rc} · twin-stream frames ${stats.frames} · invalid ${stats.invalid}</p>
<h2 style="font:600 14px system-ui">Latest value per actor.property</h2><pre>${actors || 'none yet'}</pre>
<h2 style="font:600 14px system-ui">Problems</h2><pre>${stats.problems.slice(-10).join('\n') || 'none'}</pre>
<h2 style="font:600 14px system-ui">Last message</h2><pre>${stats.last ? JSON.stringify(stats.last, null, 2).replace(/</g, '&lt;') : 'none'}</pre></body>`);
});
const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => {
  stats.connections++;
  ws.on('message', (data) => {
    let m;
    try { m = JSON.parse(String(data)); } catch { stats.invalid++; stats.problems.push('not JSON'); return; }
    stats.last = m;
    if (m.type === 'ems.frame') {
      stats.frames++;
      for (const [actor, props] of Object.entries(m.parts ?? {})) for (const [k, v] of Object.entries(props)) stats.actors[`${actor}.${k}`] = v;
      return;
    }
    const errs = checkRc(m);
    if (errs.length) { stats.invalid++; stats.problems.push(errs.join('; ')); ws.send(JSON.stringify({ RequestId: m.Parameters?.RequestId ?? -1, ResponseCode: 400 })); return; }
    stats.rc++;
    const b = m.Parameters.Body;
    stats.actors[`${b.objectPath.split('.').pop()}.${b.propertyName}`] = b.propertyValue[b.propertyName];
    ws.send(JSON.stringify({ RequestId: m.Parameters.RequestId, ResponseCode: 200 }));
  });
  ws.on('close', () => { stats.connections--; });
});
server.listen(PORT, () => console.log(`mock engine on ws://127.0.0.1:${PORT} (status page http://127.0.0.1:${PORT})`));
