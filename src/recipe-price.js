import { fetchMarket, fetchHistory } from './universalis.js';
import { planPurchase, greedyCost } from './pricing.js';

/** Short-lived cache of Universalis responses so re-pricing is instant. */
const marketCache = new Map();
const MARKET_TTL_MS = 60_000;

export async function marketFor(world, ids) {
  const now = Date.now();
  const out = {};
  const missing = [];
  for (const id of ids) {
  const hit = marketCache.get(`${world}:${id}`);
  if (hit && now - hit.at < MARKET_TTL_MS) out[id] = hit.data;
  else missing.push(id);
  }
  for (let i = 0; i < missing.length; i += 100) {
  const chunk = missing.slice(i, i + 100);
  const res = await fetchMarket(world, chunk);
  for (const id of chunk) {
    const data = res[String(id)] || { listings: [], lastUploadTime: 0 };
    marketCache.set(`${world}:${id}`, { at: now, data });
    out[id] = data;
  }
  }
  return out;
}

const HISTORY_DAYS = 7;
const historyCache = new Map();

/**
 * What the item actually sold for over the last week, as opposed to what is
 * merely listed: average unit price, units moved, and units per day.
 */
export async function salesFor(world, itemId) {
  const key = `${world}:${itemId}`;
  const hit = historyCache.get(key);
  if (hit && Date.now() - hit.at < MARKET_TTL_MS) return hit.data;
  const raw = await fetchHistory(world, itemId, { withinSeconds: HISTORY_DAYS * 86_400 });
  const cutoff = Date.now() / 1000 - HISTORY_DAYS * 86_400;
  const stats = (rows) => {
  const units = rows.reduce((s, e) => s + e.quantity, 0);
  const gil = rows.reduce((s, e) => s + e.pricePerUnit * e.quantity, 0);
  // Median of the unit prices, weighted by quantity: a couple of absurd
  // sales cannot drag it the way they drag the average.
  let median = null;
  if (units) {
    const sorted = rows.slice().sort((a, b) => a.pricePerUnit - b.pricePerUnit);
    let seen = 0;
    for (const e of sorted) { seen += e.quantity; if (seen * 2 >= units) { median = e.pricePerUnit; break; } }
  }
  return { sales: rows.length, units, avg: units ? gil / units : null, median, perDay: units / HISTORY_DAYS,
    min: rows.length ? Math.min(...rows.map((e) => e.pricePerUnit)) : null,
    max: rows.length ? Math.max(...rows.map((e) => e.pricePerUnit)) : null };
  };
  const entries = (raw.entries || []).filter((e) => e.timestamp >= cutoff);
  const data = {
  days: HISTORY_DAYS,
  all: stats(entries),
  nq: stats(entries.filter((e) => !e.hq)),
  hq: stats(entries.filter((e) => e.hq)),
  lastSale: entries.length ? Math.max(...entries.map((e) => e.timestamp)) * 1000 : null,
  };
  historyCache.set(key, { at: Date.now(), data });
  return data;
}


/**
 * Prices one recipe against live listings: exact stack-aware plan per
 * material, vendor comparison, and the result's sale history. Shared by the
 * recipe page and by the profit finder's verification pass.
 */
export async function priceRecipe(index, r, { world, crafts = 1, quality = 'any', ignoreCrystals = false, withSales = true, inventory = null }) {
  const yields = r.yields || 1;
  const ids = [r.result, ...r.ingredients.map((i) => i.id)].filter((id) => index.items[id]?.m !== false);
  const [market, sales] = await Promise.all([
    marketFor(world, ids),
    withSales && index.items[r.result]?.m !== false ? salesFor(world, r.result).catch(() => null) : null,
  ]);

  const ingredients = r.ingredients.map((ing) => {
    const required = ing.amount * crafts;
    const item = index.items[ing.id];
    const crystal = !!item?.x;
    const excluded = crystal && ignoreCrystals;
    // Units already in the player's bags count first, whatever their quality:
    // NQ materials craft just fine, the HQ/NQ toggle only governs purchases.
    const owned = inventory?.get(ing.id);
    const have = owned ? owned.total : 0;
    const need = Math.max(0, required - have);
    const base = { id: ing.id, amount: ing.amount, required, have, haveHq: owned?.hq || 0, need, crystal, excluded };
    if (!need) {
      return { ...base, marketable: item?.m !== false, source: 'owned', cost: 0, vendor: null,
        plan: { need: 0, plan: [], units: 0, cost: 0, leftover: 0, listings: 0, short: false }, lastUpload: market[ing.id]?.lastUploadTime || 0 };
    }
    // An NPC sells exactly the quantity you want, so its cost is simply
    // price x need; it wins whenever the board's whole-stack plan is dearer.
    const vendor = item?.v ? { price: item.v.p, cost: item.v.p * need, npcs: item.v.npcs } : null;
    const data = market[ing.id];
    if (!data) {
      return { ...base, marketable: false, vendor,
        source: vendor ? 'vendor' : 'none', cost: vendor ? vendor.cost : 0 };
    }
    const listings = (data.listings || []).map((l) => ({
      pricePerUnit: l.pricePerUnit, quantity: l.quantity, hq: !!l.hq,
      worldName: l.worldName || null, retainerName: l.retainerName || null,
    }));
    const plan = planPurchase(listings, need, quality);
    const greedy = greedyCost(listings, need, quality);
    const boardOk = plan.listings > 0 && !plan.short;
    const useVendor = !!vendor && (!boardOk || vendor.cost <= plan.cost);
    return {
      source: useVendor ? 'vendor' : plan.listings ? 'board' : 'none',
      cost: useVendor ? vendor.cost : plan.cost,
      vendor,
      ...base, marketable: true, stackSize: item?.s || 1,
      lastUpload: data.lastUploadTime || 0,
      plan, greedy,
      cheapest: listings.slice().sort((a, b) => a.pricePerUnit - b.pricePerUnit).slice(0, 8),
    };
  });

  const result = market[r.result];
  const resultListings = (result?.listings || []).slice().sort((a, b) => a.pricePerUnit - b.pricePerUnit);
  const counted = ingredients.filter((i) => !i.excluded);
  const total = counted.reduce((s, i) => s + (i.cost || 0), 0);
  const crystalCost = ingredients.filter((i) => i.crystal).reduce((s, i) => s + (i.cost || 0), 0);
  const shortfall = counted.filter((i) => i.source !== 'vendor' && i.plan?.short).length;

  const ownedValue = counted.filter((i) => i.have).length;
  return {
    recipeId: r.id, world, crafts, units: crafts * yields, quality, ignoreCrystals, crystalCost,
    usedInventory: !!inventory, ownedMaterials: ownedValue,
    total, greedyTotal: counted.reduce((s, i) => s + (i.source === 'vendor' ? i.cost : (i.greedy?.cost || 0)), 0),
    perCraft: total / crafts, perUnit: total / (crafts * yields),
    shortfall, ingredients,
    result: result ? {
      marketable: true, lastUpload: result.lastUploadTime || 0,
      cheapestNq: resultListings.find((l) => !l.hq)?.pricePerUnit ?? null,
      cheapestHq: resultListings.find((l) => l.hq)?.pricePerUnit ?? null,
      listings: resultListings.length,
      sales,
    } : { marketable: false },
  };
}
