import { readShippedBytes } from './bundle.js';

/**
 * The web UI, served straight from the shipped files. There are only a handful
 * of them, so this does the whole job that a static-file plugin would, and it
 * works identically whether the files are on disk or embedded in the packaged
 * executable.
 */

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** The UI is small and never changes at runtime, so it is read once. */
const cache = new Map();

function load(urlPath) {
  if (cache.has(urlPath)) return cache.get(urlPath);
  // Only ever look inside public/, whatever the request says.
  const clean = urlPath.split('?')[0].replace(/\\/g, '/').replace(/\/+/g, '/');
  if (clean.includes('..')) return null;
  const rel = `public${clean === '/' ? '/index.html' : clean}`;
  const body = readShippedBytes(rel);
  const ext = rel.slice(rel.lastIndexOf('.'));
  const entry = body ? { body, type: TYPES[ext] || 'application/octet-stream' } : null;
  cache.set(urlPath, entry);
  return entry;
}

export function registerStatic(app) {
  app.get('/*', async (req, reply) => {
    const file = load(req.url);
    if (!file) return reply.code(404).type('text/plain').send('Not found');
    // The UI ships with the app, so it may be cached, but revalidate each
    // load so an updated build is picked up straight away.
    return reply.header('Cache-Control', 'no-cache').type(file.type).send(file.body);
  });
}
