import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sea from 'node:sea';

/**
 * Files that ship with the app: the web UI and the two lookup tables that let
 * a rebuild work when XIVAPI is unreachable.
 *
 * Running from source they are plain files on disk. In the packaged Windows
 * build they are embedded in the executable and read through Node's
 * single-executable asset API instead. Everything the app *writes* (the data
 * index, the icon cache, your inventory export) stays on disk next to the
 * executable; only these read-only files move inside it.
 */

export const packaged = sea.isSea();

/**
 * Where writable files live: the project directory when running from source,
 * the folder holding the .exe when packaged.
 */
export function appRoot() {
  if (packaged) return path.dirname(process.execPath);
  // Lazy so the bundler never has to resolve import.meta in the packaged build.
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

const shipped = (relPath, encoding) => {
  const key = relPath.replace(/\\/g, '/');
  if (packaged) {
    return encoding ? sea.getAsset(key, encoding) : Buffer.from(sea.getRawAsset(key));
  }
  const file = path.join(appRoot(), key);
  return encoding ? fs.readFileSync(file, encoding) : fs.readFileSync(file);
};

/** Reads a shipped file as text, or null when it is not there. */
export function readShipped(relPath) {
  try { return shipped(relPath, 'utf8'); } catch { return null; }
}

/** Reads a shipped file as bytes, or null when it is not there. */
export function readShippedBytes(relPath) {
  try { return shipped(relPath, null); } catch { return null; }
}
