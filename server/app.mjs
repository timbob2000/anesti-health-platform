import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { eq, desc } from '@onyx.dev/onyx-database';
import { publicConfiguration } from './config.mjs';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'application/javascript; charset=utf-8']],
  ['/app.css', ['app.css', 'text/css; charset=utf-8']],
]);
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

async function readBody(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, 'Expected JSON.');
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (Buffer.byteLength(text) > 8192) throw new HttpError(413, 'Request is too large.');
  }
  try { return JSON.parse(text); } catch { throw new HttpError(400, 'Invalid JSON.'); }
}

export function validateNote(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['title', 'body'].includes(k))) {
    throw new HttpError(400, 'Only title and body can be edited.');
  }
  if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 120 || typeof input.body !== 'string' || input.body.length > 4000) {
    throw new HttpError(400, 'Use a title of 1–120 characters and a body of at most 4,000 characters.');
  }
  return { title: input.title.trim(), body: input.body.trim() };
}

export function createHandler({ db, verifyToken, env = process.env, log = console.log }) {
  const preview = env.WORKSPACE_PREVIEW === 'true';
  let publicConfig;
  try { publicConfig = publicConfiguration(env); }
  catch (error) { if (!preview) throw error; }
  const servicesReady = !!(publicConfig && db && verifyToken);
  const appOrigin = new URL(env.APP_ORIGIN || 'http://localhost:3000').origin;
  const frameOrigin = env.PREVIEW_PARENT_ORIGIN ? new URL(env.PREVIEW_PARENT_ORIGIN).origin : "'none'";
  return async (req, res) => {
    const requestId = randomUUID();
    const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
    res.setHeader('X-Request-ID', requestId);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' https://*.googleapis.com https://*.firebaseapp.com https://securetoken.googleapis.com; frame-src https://*.firebaseapp.com https://accounts.google.com; frame-ancestors ${frameOrigin}; object-src 'none'; base-uri 'none'; form-action 'self'`);
    try {
      const url = new URL(req.url, appOrigin);
      if (req.method === 'GET' && url.pathname === '/health/live') return json(200, { status: 'alive' });
      if (req.method === 'GET' && url.pathname === '/health/ready') {
        if (preview) return json(200, { status: 'preview', servicesReady });
        await db.from('WorkspaceNote').limit(1).list();
        return json(200, { status: 'ready' });
      }
      if (req.method === 'GET' && url.pathname === '/api/config') {
        if (!servicesReady) throw new HttpError(503, 'Sign-in is not configured for this environment.');
        return json(200, publicConfig);
      }
      if (req.method === 'GET' && assets.has(url.pathname)) {
        const [name, type] = assets.get(url.pathname);
        const body = await readFile(fileURLToPath(new URL(`../dist/${name}`, import.meta.url)));
        res.writeHead(200, { 'Content-Type': type }); return res.end(body);
      }
      if (!/^\/api\/notes(?:\/[a-f0-9-]{36})?$/.test(url.pathname)) throw new HttpError(404, 'Not found.');
      if (req.headers.origin && req.headers.origin !== appOrigin) throw new HttpError(403, 'Origin is not allowed.');
      const authorization = req.headers.authorization;
      if (!authorization?.startsWith('Bearer ')) throw new HttpError(401, 'Sign in to continue.');
      if (!servicesReady) throw new HttpError(503, 'Application services are not configured for this environment.');
      let identity;
      try { identity = await verifyToken(authorization.slice(7)); } catch { throw new HttpError(401, 'Your session expired. Sign in again.'); }
      if (!identity.uid || (env.REQUIRE_WORKSPACE_ACCESS_CLAIM === 'true' && identity.workspace_access !== true)) throw new HttpError(403, 'Application access has not been granted.');
      const id = url.pathname.split('/')[3];
      if (req.method === 'GET' && !id) {
        const notes = await db.from('WorkspaceNote').where(eq('ownerId', identity.uid)).orderBy(desc('updatedAt')).limit(100).list();
        return json(200, { notes: Array.from(notes) });
      }
      if (req.method === 'POST' && !id) {
        const input = validateNote(await readBody(req));
        const note = { ...input, id: randomUUID(), ownerId: identity.uid, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        await db.save('WorkspaceNote', note); return json(201, { note });
      }
      if (id && ['PUT', 'DELETE'].includes(req.method)) {
        const note = await db.findById('WorkspaceNote', id);
        // A missing record and another user's record deliberately have the same response.
        if (!note || note.ownerId !== identity.uid) throw new HttpError(404, 'Note not found.');
        if (req.method === 'DELETE') { await db.delete('WorkspaceNote', id); return json(200, { deleted: true }); }
        const updated = { ...note, ...validateNote(await readBody(req)), updatedAt: new Date().toISOString() };
        await db.save('WorkspaceNote', updated); return json(200, { note: updated });
      }
      throw new HttpError(405, 'Method is not supported.');
    } catch (error) {
      // Do not log exceptions from SDKs: they can contain tokens, SQL/data, or credentials.
      const status = error instanceof HttpError ? error.status : 503;
      log(JSON.stringify({ event: 'request_failed', requestId, status }));
      if (!res.headersSent) json(status, { error: error instanceof HttpError ? error.message : 'Service temporarily unavailable.', requestId });
      else res.end();
    }
  };
}
