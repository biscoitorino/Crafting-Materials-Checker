import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const int = (v, d) => { const n = Number.parseInt(v ?? '', 10); return Number.isFinite(n) ? n : d; };

export const config = {
  root,
  dataDir: process.env.DATA_DIR || path.join(root, 'data'),
  indexPath: path.join(process.env.DATA_DIR || path.join(root, 'data'), 'index.json'),
  itemLang: (process.env.ITEM_LANG || 'en').toLowerCase(),
  defaultWorld: process.env.DEFAULT_WORLD || 'Coeurl',
  port: int(process.env.PORT, 8790),
  host: process.env.HOST || '127.0.0.1',
  universalisBase: 'https://universalis.app/api/v2',
  iconHost: 'https://v2.xivapi.com',
  teamcraftBase: 'https://raw.githubusercontent.com/ffxiv-teamcraft/ffxiv-teamcraft/staging/libs/data/src/lib/json',
  userAgent: 'CraftingMaterialsChecker/1.0 (personal crafting cost tool)',
};
