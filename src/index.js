import { loadIndex, fetchDataVersion } from './data.js';
import { startServer } from './server.js';
import { config } from './config.js';
import { desktopMode, startFileLog, openBrowser, alreadyRunning } from './desktop.js';

// Wrapped rather than top-level await, so the packaged build can be bundled
// as CommonJS.
async function main() {
  if (process.argv.includes('--rebuild')) {
    const version = await fetchDataVersion().catch(() => null);
    await loadIndex({ rebuild: true, version });
    return;
  }

  const url = `http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${config.port}/`;

  if (desktopMode) {
    // Double-clicking the icon again should bring up what is already running
    // rather than fail on the port.
    if (await alreadyRunning(url)) {
      openBrowser(url);
      return;
    }
    startFileLog();
    await startServer();
    openBrowser(url);
    return;
  }

  await startServer();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
