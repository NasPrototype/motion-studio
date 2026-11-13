import type { IncomingMessage, ServerResponse } from 'node:http';
import { analyzePhotos, credentialsHint, type PhotoInput, TwinError } from './photo-to-twin';

const MAX_BODY = 24 * 1024 * 1024;
const MEDIA = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new TwinError(413, 'Photos are too large. Use at most four photos under 5 MB each.');
    chunks.push(chunk as Buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new TwinError(400, 'The request body was not JSON.'); }
}

/** Handles /api/* for both the Vite dev server and the production server. Returns false if not an API path. */
export async function handleApi(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://local');
  if (!url.pathname.startsWith('/api/')) return false;
  try {
    if (url.pathname === '/api/health' && req.method === 'GET') {
      send(res, 200, { photoToTwin: credentialsHint() === 'env' ? 'ready' : 'unconfigured' });
      return true;
    }
    if (url.pathname === '/api/photo-to-twin' && req.method === 'POST') {
      const body = (await readJson(req)) as { images?: unknown; note?: unknown };
      const images = Array.isArray(body.images) ? body.images : [];
      const clean: PhotoInput[] = images.map((x) => {
        const o = x as Record<string, unknown>;
        if (typeof o.data !== 'string' || !MEDIA.has(String(o.mediaType))) throw new TwinError(400, 'Each photo needs JPEG, PNG, WebP or GIF data.');
        return { mediaType: o.mediaType as PhotoInput['mediaType'], data: o.data };
      });
      const draft = await analyzePhotos(clean, typeof body.note === 'string' ? body.note.slice(0, 2000) : '');
      send(res, 200, { draft });
      return true;
    }
    send(res, 404, { error: 'Unknown API route.' });
  } catch (err) {
    if (err instanceof TwinError) send(res, err.status, { error: err.message });
    else {
      console.error('[api]', err);
      send(res, 500, { error: 'The server hit an unexpected error. See the server log.' });
    }
  }
  return true;
}
