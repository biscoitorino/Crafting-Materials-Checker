import { loadIndex, fetchDataVersion } from './data.js';
import { startServer } from './server.js';

if (process.argv.includes('--rebuild')) {
  const version = await fetchDataVersion().catch(() => null);
  await loadIndex({ rebuild: true, version });
  process.exit(0);
}
await startServer();
