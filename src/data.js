import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { marketableIds } from './universalis.js';

/**
 * Recipe and item data come from the FFXIV Teamcraft data set, which is kept
 * current with each patch. Everything the UI needs is condensed into one
 * `data/index.json` on first run: recipes for the eight crafting classes, and
 * only the items those recipes touch (results and ingredients).
 */

const CRAFTERS = { 8: 'CRP', 9: 'BSM', 10: 'ARM', 11: 'GSM', 12: 'LTW', 13: 'WVR', 14: 'ALC', 15: 'CUL' };
const JOB_NAMES = {
  8: 'Carpenter', 9: 'Blacksmith', 10: 'Armorer', 11: 'Goldsmith',
  12: 'Leatherworker', 13: 'Weaver', 14: 'Alchemist', 15: 'Culinarian',
};
const VERSION = 6;
const GIL = 1;
/** Teamcraft UI category for shards, crystals and clusters. */
const CRYSTAL_CATEGORY = 59;

async function fetchJson(name, { log, optional = false }) {
  const url = `${config.teamcraftBase}/${name}.json`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': config.userAgent }, signal: AbortSignal.timeout(180_000) });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.json();
  } catch (err) {
    if (!optional) throw new Error(`${name}.json download failed: ${err.message}`);
    log(`[data] ${name}.json unavailable (${err.message}); continuing without it.`);
    return {};
  }
}

/**
 * Seals paid per item level for GC expert deliveries, from the game's
 * GCSupplyDutyReward sheet via XIVAPI. A copy ships in assets/gc-seals.json so a
 * rebuild still works when XIVAPI is down.
 */
async function fetchGcSeals({ log }) {
  const fallback = path.join(config.root, 'assets', 'gc-seals.json');
  try {
    const table = {};
    for (const after of [null, 499]) {
      const url = `${config.iconHost}/api/sheet/GCSupplyDutyReward?limit=500&fields=SealsExpertDelivery${after ? `&after=${after}` : ''}`;
      const res = await fetch(url, { headers: { 'User-Agent': config.userAgent }, signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      for (const row of (await res.json()).rows) {
        if (row.fields?.SealsExpertDelivery > 0) table[row.row_id] = row.fields.SealsExpertDelivery;
      }
    }
    if (!Object.keys(table).length) throw new Error('empty sheet');
    fs.writeFileSync(fallback, JSON.stringify(table));
    return table;
  } catch (err) {
    log(`[data] GC seal table unavailable from XIVAPI (${err.message}); using the shipped copy.`);
    try { return JSON.parse(fs.readFileSync(fallback, 'utf8')); } catch { return {}; }
  }
}

/**
 * Which master book each recipe needs, from the game's Recipe sheet via XIVAPI.
 * Returns { byRecipe: { recipeId: bookId }, books: { bookId: name } }. A copy
 * is kept in assets/master-books.json for offline rebuilds.
 */
async function fetchMasterBooks({ log }) {
  const fallback = path.join(config.root, 'assets', 'master-books.json');
  try {
    const byRecipe = {};
    const books = {};
    let after = null;
    for (let page = 0; page < 200; page++) {
      const url = `${config.iconHost}/api/sheet/Recipe?limit=500&fields=SecretRecipeBook.Name${after != null ? `&after=${after}` : ''}`;
      const res = await fetch(url, { headers: { 'User-Agent': config.userAgent }, signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const { rows } = await res.json();
      if (!rows?.length) break;
      for (const row of rows) {
        const book = row.fields?.SecretRecipeBook;
        if (book?.value) {
          byRecipe[row.row_id] = book.value;
          if (book.fields?.Name) books[book.value] = book.fields.Name;
        }
      }
      after = rows[rows.length - 1].row_id;
    }
    if (!Object.keys(books).length) throw new Error('no books found');
    const data = { byRecipe, books };
    fs.writeFileSync(fallback, JSON.stringify(data));
    return data;
  } catch (err) {
    log(`[data] master book table unavailable from XIVAPI (${err.message}); using the shipped copy.`);
    try { return JSON.parse(fs.readFileSync(fallback, 'utf8')); } catch { return { byRecipe: {}, books: {} }; }
  }
}

/**
 * The latest commit touching Teamcraft's data folder on the staging branch.
 * That is the "version" of the data set: if the index was built from the same
 * commit there is nothing new to download.
 */
export async function fetchDataVersion() {
  const url = 'https://api.github.com/repos/ffxiv-teamcraft/ffxiv-teamcraft/commits?sha=staging&path=libs/data/src/lib/json&per_page=1';
  const res = await fetch(url, {
    headers: { 'User-Agent': config.userAgent, Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`GitHub ${res.status} ${res.statusText}`);
  const [c] = await res.json();
  if (!c?.sha) throw new Error('no commit found');
  return { sha: c.sha, date: c.commit?.committer?.date || null, message: (c.commit?.message || '').split('\n')[0] };
}

export async function buildIndex({ log = console.log, version = null } = {}) {
  log('[data] Downloading Teamcraft data set (recipes, items, icons, ~30 MB)...');
  const [recipesRaw, items, icons, uiCats, catNames, stacks, rarities, shops, npcs, places, ilvls, equipSlots, gcSeals, masterBooks, marketable] = await Promise.all([
    fetchJson('recipes', { log }),
    fetchJson('items', { log }),
    fetchJson('item-icons', { log, optional: true }),
    fetchJson('ui-categories', { log, optional: true }),
    fetchJson('item-category', { log, optional: true }),
    fetchJson('stack-sizes', { log, optional: true }),
    fetchJson('rarities', { log, optional: true }),
    fetchJson('shops', { log, optional: true }),
    fetchJson('npcs', { log, optional: true }),
    fetchJson('places', { log, optional: true }),
    fetchJson('ilvls', { log, optional: true }),
    fetchJson('item-equip-slot-category', { log, optional: true }),
    fetchGcSeals({ log }),
    fetchMasterBooks({ log }),
    marketableIds().catch((err) => { log(`[data] marketable list unavailable (${err.message})`); return null; }),
  ]);

  const lang = config.itemLang;
  const name = (id) => (items[id]?.[lang] || items[id]?.en || '').trim();

  const recipes = [];
  const used = new Set();
  for (const r of recipesRaw) {
    if (!CRAFTERS[r.job] || !r.result || !name(r.result)) continue;
    const ingredients = r.ingredients
      .filter((i) => i.id && i.amount > 0 && name(i.id))
      .map((i) => ({ id: i.id, amount: i.amount }));
    if (!ingredients.length) continue;
    used.add(r.result);
    ingredients.forEach((i) => used.add(i.id));
    const book = masterBooks.byRecipe[r.id];
    recipes.push({
      id: r.id, job: r.job, ...(book ? { book } : {}), lvl: r.lvl, stars: r.stars || 0, rlvl: r.rlvl, yields: r.yields || 1, result: r.result,
      durability: r.durability, quality: r.quality, progress: r.progress,
      suggestedCraftsmanship: r.suggestedCraftsmanship || 0,
      craftsmanshipReq: r.craftsmanshipReq || 0, controlReq: r.controlReq || 0,
      requiredQuality: r.requiredQuality || 0,
      qs: !!r.qs, hq: !!r.hq, expert: !!r.expert, ingredients,
    });
  }

  // Which recipes make each item, so an ingredient can be followed back to
  // its own recipe.
  const madeBy = new Map();
  for (const r of recipes) {
    if (!madeBy.has(r.result)) madeBy.set(r.result, []);
    madeBy.get(r.result).push(r.id);
  }

  // Gil vendors: item id -> cheapest gil price and up to a few NPCs selling it,
  // with zone and map coordinates so the material can actually be found.
  const vendors = new Map();
  const shopList = Array.isArray(shops) ? shops : [];
  for (const shop of shopList) {
    if (shop.type !== 'GilShop') continue;
    for (const trade of shop.trades || []) {
      const gil = (trade.currencies || []).find((c) => c.id === GIL);
      if (!gil || (trade.currencies || []).length !== 1) continue;
      for (const sold of trade.items || []) {
        if (!used.has(sold.id) || sold.hq) continue;
        const price = gil.amount / (sold.amount || 1);
        if (!vendors.has(sold.id)) vendors.set(sold.id, { p: price, npcs: [] });
        const v = vendors.get(sold.id);
        v.p = Math.min(v.p, price);
        for (const npcId of shop.npcs || []) {
          const npc = npcs[npcId];
          if (!npc?.[lang] && !npc?.en) continue;
          if (v.npcs.some((n) => n.id === npcId)) continue;
          const pos = npc.position;
          const zone = pos ? (places[pos.zoneid]?.[lang] || places[pos.zoneid]?.en) : null;
          const entry = { id: npcId, n: npc[lang] || npc.en, p: price };
          const title = npc.title?.[lang] || npc.title?.en;
          if (title) entry.t = title;
          if (zone) { entry.z = zone; entry.x = Math.round(pos.x * 10) / 10; entry.y = Math.round(pos.y * 10) / 10; }
          v.npcs.push(entry);
        }
      }
    }
  }
  for (const v of vendors.values()) {
    // Cheapest first, then the ones with a known location, then cap the list.
    v.npcs.sort((a, b) => a.p - b.p || (b.z ? 1 : 0) - (a.z ? 1 : 0));
    v.npcs = v.npcs.slice(0, 6).map(({ id, ...rest }) => rest);
  }

  const itemIndex = {};
  for (const id of used) {
    const entry = { n: name(id) };
    if (typeof icons[id] === 'string') entry.i = icons[id];
    const cat = catNames[uiCats[id]]?.[lang] || catNames[uiCats[id]]?.en;
    if (cat) entry.c = cat;
    if (Number(uiCats[id]) === CRYSTAL_CATEGORY) entry.x = true;
    entry.s = stacks[id] || 1;
    // 1 basic, 2 uncommon (green), 3 rare (blue), 4 relic (purple), 7 aetherial (pink)
    entry.q = rarities[id] || 1;
    if (vendors.has(id)) entry.v = vendors.get(id);
    // Grand Company expert delivery: any piece of equipment, seals by item level.
    const ilvl = ilvls[id];
    if (equipSlots[id] && ilvl && gcSeals[ilvl]) { entry.l = ilvl; entry.g = gcSeals[ilvl]; }
    if (marketable) entry.m = marketable.has(id);
    if (madeBy.has(id)) entry.r = madeBy.get(id);
    itemIndex[id] = entry;
  }

  recipes.sort((a, b) => a.job - b.job || a.lvl - b.lvl || a.stars - b.stars || name(a.result).localeCompare(name(b.result)));

  // Master books, each tagged with the class whose recipes use it.
  const books = {};
  for (const r of recipes) {
    if (!r.book) continue;
    if (!books[r.book]) books[r.book] = { name: masterBooks.books[r.book] || `Book ${r.book}`, job: r.job, recipes: 0 };
    books[r.book].recipes++;
  }

  const index = {
    version: VERSION, builtAt: new Date().toISOString(), lang, books,
    source: version || null,
    jobs: Object.fromEntries(Object.entries(CRAFTERS).map(([id, abbr]) => [id, { abbr, name: JOB_NAMES[id] }])),
    recipes, items: itemIndex,
  };
  fs.mkdirSync(path.dirname(config.indexPath), { recursive: true });
  fs.writeFileSync(config.indexPath, JSON.stringify(index));
  log(`[data] Wrote ${recipes.length} recipes, ${used.size} items (${vendors.size} sold by gil vendors) to ${config.indexPath}`);
  cache = index;
  return index;
}

let cache = null;
export const currentIndex = () => cache;

export async function loadIndex({ rebuild = false, version = null } = {}) {
  if (cache && !rebuild) return cache;
  if (!rebuild && fs.existsSync(config.indexPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(config.indexPath, 'utf8'));
      if (parsed.version === VERSION && parsed.lang === config.itemLang && parsed.recipes?.length) {
        cache = parsed;
        return cache;
      }
    } catch { /* rebuild below */ }
  }
  return buildIndex({ version });
}

export const iconUrl = (item) => (item?.i ? `${config.iconHost}${item.i}` : null);
