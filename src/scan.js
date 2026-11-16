import { fetchAggregated, worldsAndDcs } from './universalis.js';
import { priceRecipe, salesFor as fetchHistoryStats } from './recipe-price.js';

/**
 * Profit finder.
 *
 * Given what the player can craft (class levels, master books) it ranks
 * recipes by how much they earn on the chosen market. Prices come from
 * Universalis' aggregated endpoint, which reports the average sale price and
 * sale velocity of 100 items per request, so a scan of a few thousand recipes
 * is a few dozen requests rather than thousands. Results are cached for ten
 * minutes per market, batches are sent one at a time with a pause between
 * them, and only one scan runs at once.
 */

const CACHE_TTL_MS = 10 * 60 * 1000;
const BATCH = 100;
export const PAUSE_MS = 150;
export const CONCURRENCY = 3;
export const SALE_TAX = 0.05;
/** How many of the best estimates get checked against live listings. */
const VERIFY_TOP = 40;
/** Hard cap on live checks per scan, however much the ranking churns. */
const VERIFY_MAX = 120;

/** market -> Map(itemId -> { at, stats }) */
const cache = new Map();
const jobs = new Map();
let running = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let dcNames = null;
async function isDataCentre(name) {
  if (!dcNames) dcNames = new Set((await worldsAndDcs().catch(() => [])).map((d) => d.name.toLowerCase()));
  return dcNames.has(String(name).toLowerCase());
}

/** Flattens one aggregated result to the numbers the ranking needs. */
function condense(res, scope) {
  const pick = (block) => block?.[scope] ?? null;
  const side = (q) => ({
    min: pick(q?.minListing)?.price ?? null,
    avg: pick(q?.averageSalePrice)?.price ?? null,
    velocity: pick(q?.dailySaleVelocity)?.quantity ?? 0,
  });
  return { nq: side(res.nq), hq: side(res.hq) };
}

export async function statsFor(market, ids, onProgress) {
  const scope = (await isDataCentre(market)) ? 'dc' : 'world';
  if (!cache.has(market)) cache.set(market, new Map());
  const store = cache.get(market);
  const now = Date.now();
  const out = new Map();
  const missing = [];
  for (const id of new Set(ids)) {
    const hit = store.get(id);
    if (hit && now - hit.at < CACHE_TTL_MS) { if (hit.stats) out.set(id, hit.stats); }
    else missing.push(id);
  }
  onProgress?.(0, missing.length);
  const chunks = [];
  for (let i = 0; i < missing.length; i += BATCH) chunks.push(missing.slice(i, i + BATCH));
  let done = 0;
  let cursor = 0;
  // A few batches in flight at once: the endpoint is slow per call rather
  // than strict on rate, and this stays far below Universalis' limits.
  const workers = Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, async () => {
    while (cursor < chunks.length) {
      const chunk = chunks[cursor++];
      let results = [];
      try {
        results = await fetchAggregated(market, chunk);
      } catch (err) {
        // One failed batch should not sink the scan; those items just have no data.
        console.error('[scan] batch failed:', err.message);
      }
      const seen = new Set();
      for (const r of results) {
        const stats = condense(r, scope);
        store.set(r.itemId, { at: Date.now(), stats });
        out.set(r.itemId, stats);
        seen.add(r.itemId);
      }
      for (const id of chunk) if (!seen.has(id)) store.set(id, { at: Date.now(), stats: null });
      done += chunk.length;
      onProgress?.(done, missing.length);
      await sleep(PAUSE_MS);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * @param {object} index          the recipe/item index
 * @param {object} opts
 * @param {string} opts.market    world or data centre
 * @param {Record<number, number>} opts.levels  crafter job id -> level (0 = not levelled)
 * @param {number[]} opts.books   master book ids owned
 * @param {boolean} opts.expert   include expert recipes
 * @param {number} opts.minSoldWeek  drop items selling fewer units per week
 * @param {'nq'|'hq'} opts.sellAs
 * @param {boolean} opts.ignoreCrystals
 * @param {'profit'|'margin'|'weekly'} opts.sortBy
 */
export function startScan(index, opts) {
  if (running && jobs.get(running)?.status === 'running') {
    return { id: running, reused: true };
  }
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const job = { id, status: 'running', done: 0, total: 0, phase: 'preparing', startedAt: Date.now(), results: null, error: null, candidates: 0 };
  jobs.set(id, job);
  running = id;
  runScan(index, opts, job).catch((err) => { job.status = 'error'; job.error = err.message; });
  // Forget old jobs after a while.
  for (const [k, j] of jobs) if (Date.now() - j.startedAt > 30 * 60 * 1000) jobs.delete(k);
  return { id, reused: false };
}

export const getScan = (id) => jobs.get(id) || null;

async function runScan(index, opts, job) {
  if (opts.mode === 'sell') return runSellScan(index, opts, job);
  const inv = opts.inventory || null;
  const ownedUnits = (id, hq) => {
    const o = inv?.get(id);
    return o ? (hq ? o.hq : o.total) : 0;
  };
  // How many finished units the player wants to make; costs and totals are
  // for that batch, so stack effects and owned materials play out realistically.
  const wantUnits = Math.max(1, Math.min(999, Number(opts.units) || 1));
  const batchCrafts = (r) => Math.max(1, Math.ceil(wantUnits / (r.yields || 1)));
  const levels = opts.levels || {};
  const books = new Set((opts.books || []).map(Number));
  const candidates = index.recipes.filter((r) => {
    const lvl = Number(levels[r.job]) || 0;
    if (!lvl || r.lvl > lvl) return false;
    if (r.book && !books.has(r.book)) return false;
    if (r.expert && !opts.expert) return false;
    const item = index.items[r.result];
    if (!item || item.m === false) return false;
    // "From my inventory": every material must be in the bags for at least one craft.
    if (opts.mode === 'own') {
      if (!inv) return false;
      return r.ingredients.every((g) => (opts.ignoreCrystals && index.items[g.id]?.x) || ownedUnits(g.id) >= g.amount);
    }
    return true;
  });
  job.candidates = candidates.length;

  // Results first, so items that do not sell can be dropped before their
  // ingredients are ever priced.
  job.phase = 'sales';
  const resultIds = [...new Set(candidates.map((r) => r.result))];
  const resultStats = await statsFor(opts.market, resultIds, (d, t) => { job.done = d; job.total = t; });

  const sellAs = opts.sellAs === 'hq' ? 'hq' : 'nq';
  const minWeek = Math.max(0, Number(opts.minSoldWeek) || 0);
  const selling = candidates.filter((r) => {
    const s = resultStats.get(r.result)?.[sellAs];
    return s && s.avg && s.velocity * 7 >= minWeek;
  });

  job.phase = 'materials';
  job.done = 0;
  const ingredientIds = new Set();
  for (const r of selling) {
    for (const ing of r.ingredients) {
      const item = index.items[ing.id];
      if (!item || item.m === false || (opts.ignoreCrystals && item.x)) continue;
      // Fully owned materials still get priced in "own" mode, to show what
      // selling them raw would have fetched; in "buy" mode they cost nothing.
      if (opts.mode !== 'own' && ownedUnits(ing.id) >= ing.amount) continue;
      ingredientIds.add(ing.id);
    }
  }
  const ingStats = await statsFor(opts.market, [...ingredientIds], (d, t) => { job.done = d; job.total = t; });

  job.phase = 'ranking';
  const rows = [];
  for (const r of selling) {
    const sale = resultStats.get(r.result)[sellAs];
    let cost = 0;
    let rawValue = 0;
    let unknown = 0;
    let craftable = Infinity;
    const mats = [];
    for (const ing of r.ingredients) {
      const item = index.items[ing.id];
      if (opts.ignoreCrystals && item?.x) continue;
      const st = ingStats.get(ing.id);
      const have = ownedUnits(ing.id);
      if (opts.mode === 'own') {
        // Owned outright: no purchase, but note what the materials are worth raw.
        craftable = Math.min(craftable, Math.floor(have / ing.amount));
        const raw = st?.nq?.avg ?? st?.nq?.min ?? item?.v?.p ?? 0;
        rawValue += raw * ing.amount;
        mats.push({ id: ing.id, amount: ing.amount, unit: 0, have, source: 'owned' });
        continue;
      }
      const required = ing.amount * batchCrafts(r);
      if (have >= required) { mats.push({ id: ing.id, amount: ing.amount, unit: 0, have, source: 'owned' }); continue; }
      // Cheapest current NQ listing, or the vendor if that beats it. This is
      // the per-unit estimate; the recipe page does the exact stack maths.
      const board = st?.nq?.min ?? st?.hq?.min ?? null;
      const vendor = item?.v?.p ?? null;
      let unit = null;
      let source = 'none';
      if (vendor != null && (board == null || vendor <= board)) { unit = vendor; source = 'vendor'; }
      else if (board != null) { unit = board; source = 'board'; }
      if (unit == null) { unknown++; mats.push({ id: ing.id, amount: ing.amount, unit: null, have, source }); continue; }
      cost += unit * (required - have);
      mats.push({ id: ing.id, amount: ing.amount, unit, have, source });
    }
    if (unknown) continue; // cannot price it honestly
    const yields = r.yields || 1;
    const crafts = batchCrafts(r);
    const units = crafts * yields;
    // You sell by undercutting whoever is cheapest right now, so the weekly
    // average cannot be counted above the current cheapest listing. This also
    // neutralises a single absurd sale skewing the average.
    const capped = sale.min != null && sale.min < sale.avg;
    const sellAt = capped ? sale.min : sale.avg;
    const revenue = sellAt * (1 - SALE_TAX);
    const costPerUnit = opts.mode === 'own' ? 0 : cost / units;
    const profit = revenue - costPerUnit;
    const soldWeek = sale.velocity * 7;
    const ownCrafts = opts.mode === 'own' ? (Number.isFinite(craftable) ? craftable : 0) : null;
    rows.push({
      recipeId: r.id, itemId: r.result, job: r.job, lvl: r.lvl, stars: r.stars, yields,
      crafts: opts.mode === 'own' ? ownCrafts : crafts, units,
      batchCost: opts.mode === 'own' ? 0 : cost,
      batchProfit: opts.mode === 'own' ? null : profit * units,
      overDemand: opts.mode === 'own' ? false : units > soldWeek,
      rawValuePerCraft: opts.mode === 'own' ? rawValue : null,
      // In "own" mode the gain is what crafting adds over selling the materials raw,
      // for as many crafts as the bags allow (never more than the market moves in a week).
      gain: opts.mode === 'own' ? (revenue * yields - rawValue) * Math.min(ownCrafts, Math.max(1, Math.ceil(soldWeek / yields))) : null,
      // Aggregated data only knows units; the verification pass replaces this
      // with real transaction counts (a stack of 33 is one sale).
      sellAvg: sale.avg, sellMin: sale.min, sellAt, capped, soldWeek, soldUnits: soldWeek, salesKnown: false, perDay: sale.velocity,
      costPerCraft: opts.mode === 'own' ? 0 : cost / crafts, costPerUnit, profit,
      margin: costPerUnit > 0 ? profit / costPerUnit : null,
      weekly: profit * soldWeek,
      mats,
    });
  }
  const key = opts.mode === 'own' ? 'gain' : opts.sortBy === 'margin' ? 'margin' : opts.sortBy === 'weekly' ? 'weekly' : opts.sortBy === 'batch' ? 'batchProfit' : 'profit';
  const rank = () => rows.sort((a, b) => (b[key] ?? -Infinity) - (a[key] ?? -Infinity));
  rank();

  // The aggregated view ignores quantities and can lag the board, so the
  // best estimates are re-priced against live listings: exact stack costs,
  // and anything whose materials cannot actually be bought is dropped.
  job.phase = 'verifying';
  job.done = 0;
  job.total = Math.min(VERIFY_TOP, rows.length);
  const unmakeable = [];
  const verified = new Set();
  let checked = 0;
  const verifyOne = async (row) => {
    const r = index.recipes.find((x) => x.id === row.recipeId);
    const exact = await priceRecipe(index, r, { world: opts.market, crafts: opts.mode === 'own' ? 1 : batchCrafts(r), quality: 'any', ignoreCrystals: !!opts.ignoreCrystals, withSales: true, inventory: inv });
    const missing = exact.ingredients.filter((g) => !g.excluded && (g.source === 'none' || (g.source === 'board' && g.plan?.short)));
    if (missing.length) {
      unmakeable.push({ itemId: row.itemId, missing: missing.map((g) => g.id) });
      return false;
    }
    // Live sale price too: the median of the week's sales, capped at the
    // cheapest current listing of that quality.
    const hist = exact.result?.sales?.[sellAs];
    const listed = sellAs === 'hq' ? exact.result?.cheapestHq : exact.result?.cheapestNq;
    if (hist?.units) {
      row.sellAvg = hist.avg;
      row.sellMedian = hist.median;
      row.soldWeek = hist.sales;
      row.soldUnits = hist.units;
      row.salesKnown = true;
      row.perDay = hist.sales / 7;
      row.sellAt = listed != null ? Math.min(hist.median, listed) : hist.median;
      row.capped = listed != null && listed < hist.median;
    } else if (listed != null) {
      row.sellAt = Math.min(row.sellAt, listed);
      row.capped = true;
    }
    if (row.soldWeek < minWeek) {
      // The aggregated velocity said it sells; the actual week's history disagrees.
      unmakeable.push({ itemId: row.itemId, missing: [], reason: `only ${row.soldWeek} sale${row.soldWeek === 1 ? '' : 's'} this week` });
      return false;
    }
    row.costPerCraft = exact.perCraft;
    row.costPerUnit = exact.perUnit;
    row.profit = row.sellAt * (1 - SALE_TAX) - row.costPerUnit;
    row.margin = row.costPerUnit > 0 ? row.profit / row.costPerUnit : null;
    row.weekly = row.profit * row.soldUnits;
    if (opts.mode !== 'own') {
      row.batchCost = exact.total;
      row.batchProfit = row.profit * exact.units;
      row.units = exact.units;
      row.overDemand = exact.units > row.soldUnits;
    }
    row.mats = exact.ingredients.filter((g) => !g.excluded).map((g) => ({ id: g.id, amount: g.amount, have: g.have, unit: g.need ? g.cost / g.need : 0, source: g.source }));
    if (opts.mode === 'own') {
      row.gain = (row.sellAt * (1 - SALE_TAX) * row.yields - row.rawValuePerCraft) * Math.min(row.crafts, Math.max(1, Math.ceil(row.soldUnits / row.yields)));
    }
    row.verified = true;
    return true;
  };

  // Rounds: take the best-ranked unchecked rows, check a few in parallel,
  // re-rank, repeat until the top is verified or the budget is spent.
  while (checked < VERIFY_MAX) {
    const batch = rows.filter((x, idx) => idx < VERIFY_TOP && !verified.has(x.recipeId)).slice(0, CONCURRENCY);
    if (!batch.length) break;
    batch.forEach((x) => verified.add(x.recipeId));
    let outcomes;
    try {
      outcomes = await Promise.all(batch.map((row) => verifyOne(row)));
    } catch (err) {
      console.error('[scan] verify failed:', err.message);
      break;
    }
    checked += batch.length;
    job.done = checked;
    job.total = Math.max(job.total, checked);
    for (let k = 0; k < batch.length; k++) {
      if (!outcomes[k]) rows.splice(rows.indexOf(batch[k]), 1);
    }
    rank();
    await sleep(PAUSE_MS);
  }

  // Verified rows first, then whatever is still only an estimate.
  rows.sort((a, b) => (b.verified ? 1 : 0) - (a.verified ? 1 : 0) || (b[key] ?? -Infinity) - (a[key] ?? -Infinity));

  job.results = rows.slice(0, 200);
  job.summary = { mode: opts.mode || 'buy', usedInventory: !!inv, units: wantUnits, candidates: candidates.length, selling: selling.length, priced: rows.length, tax: SALE_TAX, sellAs, market: opts.market, sortBy: key, verified: checked, unmakeable };
  job.status = 'done';
  job.phase = 'done';
}

/**
 * "Sell what I own": every marketable item in the bags, valued at what it
 * would fetch now, ranked by total value. The best rows are then checked
 * against the week's sale history for a median price.
 */
async function runSellScan(index, opts, job) {
  const inv = opts.inventory;
  if (!inv) throw new Error('no inventory loaded');
  const ids = [...inv.keys()].filter((id) => index.items[id]?.m !== false);
  job.candidates = ids.length;
  job.phase = 'sales';
  const stats = await statsFor(opts.market, ids, (d, t) => { job.done = d; job.total = t; });
  const minWeek = Math.max(0, Number(opts.minSoldWeek) || 0);
  const rows = [];
  for (const id of ids) {
    const owned = inv.get(id);
    const st = stats.get(id);
    if (!st) continue;
    for (const q of ['nq', 'hq']) {
      const qty = owned[q];
      if (!qty) continue;
      const side = st[q];
      if (!side?.avg || side.velocity * 7 < minWeek) continue;
      const capped = side.min != null && side.min < side.avg;
      const sellAt = capped ? side.min : side.avg;
      rows.push({
        itemId: id, hq: q === 'hq', qty, sellAt, sellAvg: side.avg, capped,
        soldWeek: side.velocity * 7, soldUnits: side.velocity * 7, salesKnown: false, perDay: side.velocity,
        value: sellAt * (1 - SALE_TAX) * qty,
        where: owned.where.filter((w) => w.hq === (q === 'hq')),
      });
    }
  }
  rows.sort((a, b) => b.value - a.value);

  job.phase = 'verifying';
  job.done = 0;
  job.total = Math.min(VERIFY_TOP, rows.length);
  let checked = 0;
  for (let i = 0; i < rows.length && checked < VERIFY_TOP; i += CONCURRENCY) {
    const batch = rows.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (row) => {
      try {
        const hist = await fetchHistoryStats(opts.market, row.itemId);
        const side = hist?.[row.hq ? 'hq' : 'nq'];
        if (side?.units) {
          const cache = statsCache(opts.market, row.itemId);
          const listed = cache?.[row.hq ? 'hq' : 'nq']?.min ?? null;
          row.sellAvg = side.avg;
          row.soldWeek = side.sales;
          row.soldUnits = side.units;
          row.salesKnown = true;
          row.perDay = side.sales / 7;
          row.sellAt = listed != null ? Math.min(side.median, listed) : side.median;
          row.capped = listed != null && listed < side.median;
          row.value = row.sellAt * (1 - SALE_TAX) * row.qty;
        }
        row.verified = true;
      } catch (err) {
        console.error('[scan] sell verify failed:', err.message);
      }
    }));
    checked += batch.length;
    job.done = checked;
    await sleep(PAUSE_MS);
  }
  rows.sort((a, b) => b.value - a.value);
  job.results = rows.slice(0, 200);
  job.summary = { mode: 'sell', usedInventory: true, candidates: ids.length, priced: rows.length, tax: SALE_TAX, market: opts.market, verified: checked, unmakeable: [] };
  job.status = 'done';
  job.phase = 'done';
}

function statsCache(market, id) {
  return cache.get(market)?.get(id)?.stats || null;
}
