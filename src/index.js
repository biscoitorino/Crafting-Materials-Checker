import { loadIndex, fetchDataVersion } from './data.js';
import { startServer } from './server.js';

// Wrapped rather than top-level await, so the packaged build can be bundled
// as CommonJS.
async function main() {
  if (process.argv.includes('--rebuild')) {
    const version = await fetchDataVersion().catch(() => null);
    await loadIndex({ rebuild: true, version });
    return;
  }
  await startServer();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
