import { config } from './config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(pathname, params = {}, { retries = 2 } = {}) {
  const url = new URL(config.universalisBase + pathname);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': config.userAgent, Accept: 'application/json' },
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status === 429) { await sleep(2000 * (attempt + 1)); continue; }
      if (!res.ok) throw new Error(`Universalis ${res.status} ${res.statusText} for ${url.pathname}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await sleep(1000 * (attempt + 1));
    }
  }
  throw lastErr;
}

/** Current listings for up to 100 item IDs on one world or data centre. */
export async function fetchMarket(world, itemIds, { listings = 100 } = {}) {
  const ids = [...new Set(itemIds.map(Number))];
  if (!ids.length) return {};
  const data = await get(`/${encodeURIComponent(world)}/${ids.join(',')}`, { listings, entries: 0 });
  if (data.items) return data.items;
  return { [String(data.itemID ?? ids[0])]: data };
}

/** Sales within the last `withinSeconds` for one item on a world or data centre. */
export async function fetchHistory(world, itemId, { withinSeconds = 7 * 86_400, entries = 500 } = {}) {
  return get(`/history/${encodeURIComponent(world)}/${Number(itemId)}`, { entriesToReturn: entries, entriesWithin: withinSeconds });
}

/**
 * The aggregated view: per item, cheapest listing, average sale price and
 * daily sale velocity for the world, its data centre and region. Up to 100
 * items per request, which is what makes scanning affordable.
 */
export async function fetchAggregated(world, itemIds) {
  const ids = [...new Set(itemIds.map(Number))].slice(0, 100);
  if (!ids.length) return [];
  const data = await get(`/aggregated/${encodeURIComponent(world)}/${ids.join(',')}`);
  return data.results || [];
}

let marketableCache = null;
export async function marketableIds() {
  if (!marketableCache) marketableCache = new Set(await get('/marketable'));
  return marketableCache;
}

let worldsCache = null;
export async function worldsAndDcs() {
  if (!worldsCache) {
    const [worlds, dcs] = await Promise.all([get('/worlds'), get('/data-centers')]);
    const byId = new Map(worlds.map((w) => [w.id, w.name]));
    worldsCache = dcs
      .filter((dc) => dc.worlds?.length)
      .map((dc) => ({ name: dc.name, region: dc.region, worlds: dc.worlds.map((id) => byId.get(id)).filter(Boolean).sort() }))
      .sort((a, b) => a.region.localeCompare(b.region) || a.name.localeCompare(b.name));
  }
  return worldsCache;
}
