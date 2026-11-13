/**
 * Production server: serves the built Studio from dist/ and the /api routes.
 * Build with `npm run build`, then `npm run serve`. The Anthropic key stays on this server.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { handleApi } from './api';

const root = resolve(process.env.STUDIO_DIST ?? 'dist');
const port = Number(process.env.PORT ?? 8080);
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};

createServer(async (req, res) => {
  if (await handleApi(req, res)) return;
  const path = normalize(decodeURIComponent(new URL(req.url ?? '/', 'http://local').pathname)).replace(/^([.][.][/\\])+/, '');
  let file = join(root, path);
  if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html');
  res.setHeader('content-type', TYPES[extname(file)] ?? 'application/octet-stream');
  createReadStream(file).pipe(res);
}).listen(port, () => console.log(`Motion Studio on http://localhost:${port}`));
