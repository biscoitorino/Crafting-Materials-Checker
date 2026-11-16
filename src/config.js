import fs from 'node:fs';
import path from 'node:path';
import { appRoot, packaged } from './bundle.js';

const root = appRoot();

// Running from source, `npm start` passes --env-file-if-exists. The packaged
// executable has no such flag, so it reads the .env beside itself here.
if (packaged) {
  const envFile = path.join(root, '.env');
  if (fs.existsSync(envFile)) {
    try { process.loadEnvFile(envFile); } catch { /* a malformed .env is not fatal */ }
  }
}
const int = (v, d) => { const n = Number.parseInt(v ?? '', 10); return Number.isFinite(n) ? n : d; };

export const config = {
  root,
  dataDir: process.env.DATA_DIR || path.join(root, 'data'),
  indexPath: path.join(process.env.DATA_DIR || path.join(root, 'data'), 'index.json'),
  itemLang: (process.env.ITEM_LANG || 'en').toLowerCase(),
  // No world baked in: without one the picker starts on the first data centre.
  defaultWorld: process.env.DEFAULT_WORLD || '',
  port: int(process.env.PORT, 8790),
  // Packaged only: minutes of nobody using it before it shuts itself down. 0 keeps it running.
  idleExitMinutes: int(process.env.IDLE_EXIT_MINUTES, 20),
  host: process.env.HOST || '127.0.0.1',
  universalisBase: 'https://universalis.app/api/v2',
  iconHost: 'https://v2.xivapi.com',
  teamcraftBase: 'https://raw.githubusercontent.com/ffxiv-teamcraft/ffxiv-teamcraft/staging/libs/data/src/lib/json',
  // Universalis and XIVAPI ask tools to identify themselves.
  userAgent: 'CraftingMaterialsChecker/1.0 (+https://github.com/biscoitorino/Crafting-Materials-Checker)',
  packaged,
};
