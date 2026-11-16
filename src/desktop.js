import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { packaged } from './bundle.js';

/**
 * Desktop behaviour for the packaged Windows build.
 *
 * There is no tray icon and no helper process: the app is a windowed program
 * with no console, it opens your browser at the page, and the page itself is
 * where you stop it. A second double-click brings the running one forward
 * rather than starting another. If every page is closed and nothing talks to
 * it for a while, it shuts itself down so it cannot linger unnoticed.
 *
 * Running from source none of this applies — you get a terminal, which is
 * what you asked for by starting it in one.
 */

export const desktopMode = packaged && process.platform === 'win32';

const IDLE_CHECK_MS = 15 * 1000;

/**
 * Everything the app would have printed goes to a log file instead, since a
 * windowed program has nowhere to print it.
 */
export function startFileLog() {
  if (!desktopMode) return null;
  const file = path.join(config.dataDir, 'app.log');
  fs.mkdirSync(config.dataDir, { recursive: true });
  // Keep the previous run, so a crash is still readable afterwards.
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > 512 * 1024) {
      fs.renameSync(file, `${file}.1`);
    }
  } catch { /* a locked log is not worth failing over */ }

  const stream = fs.createWriteStream(file, { flags: 'a' });
  const text = (v) => {
    if (typeof v === 'string') return v;
    try { return typeof v === 'object' ? JSON.stringify(v) : String(v); } catch { return String(v); }
  };
  const write = (level) => (...args) => stream.write(`${new Date().toISOString()} ${level} ${args.map(text).join(' ')}\n`);
  console.log = write('info');
  console.info = write('info');
  console.warn = write('warn');
  console.error = write('error');
  process.on('uncaughtException', (err) => {
    write('fatal')(err?.stack || String(err));
    process.exit(1);
  });
  process.on('unhandledRejection', (err) => write('error')(err?.stack || String(err)));
  return file;
}

/** Opens the default browser, without holding on to it. */
export function openBrowser(url) {
  try {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch (err) {
    console.error('[desktop] could not open the browser:', err.message);
  }
}

/**
 * Shuts the app down once nothing has talked to it for a while, so closing
 * the browser is enough to be rid of it. Any request counts as use, which
 * covers long scans as well as someone reading a recipe.
 */
export function startIdleExit(touched) {
  const minutes = config.idleExitMinutes;
  if (!desktopMode || minutes <= 0) return;
  const limit = minutes * 60 * 1000;
  const timer = setInterval(() => {
    if (Date.now() - touched() < limit) return;
    console.log(`[desktop] nothing has used the app for ${minutes} minute${minutes === 1 ? '' : 's'}; shutting down`);
    process.exit(0);
  }, IDLE_CHECK_MS);
  timer.unref?.();
}

/**
 * True when this app is already running on the configured port, in which case
 * a second launch should just show the first one rather than fail to listen.
 */
export async function alreadyRunning(url) {
  try {
    const res = await fetch(new URL('/api/meta', url), { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return false;
    const body = await res.json();
    return typeof body?.recipes === 'number';
  } catch {
    return false;
  }
}
