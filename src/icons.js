import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { loadIndex, iconUrl } from './data.js';

/**
 * Item icons never change between patches, so each is downloaded from XIVAPI
 * once into `data/icons/<id>.png` and served from disk after that.
 */
const dir = path.join(config.dataDir, 'icons');
fs.mkdirSync(dir, { recursive: true });

const missing = new Map();
const MISS_TTL_MS = 60 * 60 * 1000;
const inflight = new Map();

export const iconPath = (id) => path.join(dir, `${Number(id)}.png`);

async function download(id) {
  const index = await loadIndex();
  const url = iconUrl(index.items[id]);
  if (!url) throw new Error(`no icon on record for item ${id}`);
  const res = await fetch(url, { headers: { 'User-Agent': config.userAgent }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`icon fetch failed: ${res.status}`);
  if (!(res.headers.get('content-type') || '').startsWith('image/')) throw new Error('icon fetch returned a non-image');
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error('empty icon body');
  const tmp = `${iconPath(id)}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, buf);
  await fsp.rename(tmp, iconPath(id));
  return iconPath(id);
}

/** Local path to the icon, downloading on first use; null when unavailable. */
export async function getIcon(itemId) {
  const id = Number(itemId);
  if (!Number.isFinite(id)) return null;
  const file = iconPath(id);
  if (fs.existsSync(file)) return file;
  const miss = missing.get(id);
  if (miss && Date.now() - miss < MISS_TTL_MS) return null;
  if (inflight.has(id)) return inflight.get(id);
  const job = download(id)
    .catch((err) => { missing.set(id, Date.now()); console.error(`[icons] item ${id}:`, err.message); return null; })
    .finally(() => inflight.delete(id));
  inflight.set(id, job);
  return job;
}
