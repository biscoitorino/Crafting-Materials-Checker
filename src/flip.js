import { statsFor, PAUSE_MS, CONCURRENCY, SALE_TAX } from './scan.js';
import { marketFor, salesFor } from './recipe-price.js';

/**
 * Flipping: buy listings that sit well under what an item actually sells for,
 * relist at market value.
 *
 * Pass one uses Universalis' aggregated view (100 items a request) to find
 * items whose cheapest listing is far below their average sale price and
 * that move enough units a week. Pass two fetches live listings and the
 * week's sale history for the best of those and works out, for each item,
 * how many of the cheap listings to buy: buying the cheapest ones makes the
 * next one your competition, so the resale price is recomputed for every
 * "buy the first n" prefix and the most profitable prefix wins, never buying
 * more than the market moves in a week. Pass three spends the budget on the
 * best return first.
 */

const VERIFY_TOP = 60;
const MIN_ROI = 0.08;
/** Never plan on more than this share of a week's sales moving through you. */
const DEMAND_SHARE = 1;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jobs = new Map();
let running = null;

export function startFlip(index, opts) {
  if (running && jobs.get(running)?.status === 'running') return { id: running, reused: true };
  const id = `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const job = { id, status: 'running', done: 0, total: 0, phase: 'preparing', startedAt: Date.now(), results: null, error: null, candidates: 0 };
  jobs.set(id, job);
  running = id;
  runFlip(index, opts, job).catch((err) => { job.status = 'error'; job.error = err.message; });
  for (const [k, j] of jobs) if (Date.now() - j.startedAt > 30 * 60 * 1000) jobs.delete(k);
  return { id, reused: false };
}

export const getFlip = (id) => jobs.get(id) || null;

/**
 * Best prefix of ascending listings to buy for one item/quality.
 * @returns {null | { buys, units, cost, resell, revenue, profit }}
 */
function planItem(listings, median, soldWeek, budgetCap) {
  const maxUnits = Math.max(1, Math.floor(soldWeek * DEMAND_SHARE));
  let best = null;
  let units = 0;
  let cost = 0;
  for (let n = 1; n <= listings.length; n++) {
    const l = listings[n - 1];
    units += l.quantity;
    cost += l.pricePerUnit * l.quantity;
    if (units > maxUnits || cost > budgetCap) break;
    // After buying the first n, the cheapest remaining listing is the ceiling
    // you must undercut; with none left the week's median is the reference.
    const next = listings[n]?.pricePerUnit ?? null;
    const resell = next != null ? Math.min(median, next - 1) : median;
    const revenue = resell * (1 - SALE_TAX) * units;
    const profit = revenue - cost;
    if (profit <= 0 || profit / cost < MIN_ROI) continue;
    if (!best || profit > best.profit) {
      best = { buys: listings.slice(0, n), units, cost, resell, revenue, profit };
    }
  }
  return best;
}

async function runFlip(index, opts, job) {
  const budget = Math.max(1000, Number(opts.budget) || 100_000);
  const minWeek = Math.max(1, Number(opts.minSoldWeek) || 5);
  const scope = opts.scope || 'all';

  // Which items to look at. Recipe results and materials are what the index
  // knows about; that is most of what changes hands on the board.
  const resultIds = new Set(index.recipes.map((r) => r.result));
  const ids = Object.keys(index.items).map(Number).filter((id) => {
    const it = index.items[id];
    if (it.m === false) return false;
    if (opts.ignoreCrystals && it.x) return false;
    if (scope === 'crafted') return resultIds.has(id);
    if (scope === 'materials') return !resultIds.has(id);
    return true;
  });
  job.candidates = ids.length;

  job.phase = 'sales';
  const stats = await statsFor(opts.market, ids, (d, t) => { job.done = d; job.total = t; });

  // Quick estimate: cheapest listing against average sale, per quality.
  const est = [];
  for (const id of ids) {
    const st = stats.get(id);
    if (!st) continue;
    for (const q of ['nq', 'hq']) {
      const s = st[q];
      if (!s?.avg || s.min == null || s.velocity * 7 < minWeek) continue;
      const perUnit = s.avg * (1 - SALE_TAX) - s.min;
      if (perUnit <= 0 || perUnit / s.min < MIN_ROI) continue;
      if (s.min > budget) continue;
      const soldWeek = s.velocity * 7;
      est.push({ id, hq: q === 'hq', min: s.min, avg: s.avg, soldWeek, perUnit, score: perUnit * Math.min(soldWeek, budget / s.min) });
    }
  }
  est.sort((a, b) => b.score - a.score);
  const shortlist = est.slice(0, VERIFY_TOP);

  job.phase = 'verifying';
  job.done = 0;
  job.total = shortlist.length;
  const plans = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, shortlist.length) }, async () => {
    while (cursor < shortlist.length) {
      const c = shortlist[cursor++];
      try {
        const [market, hist] = await Promise.all([marketFor(opts.market, [c.id]), salesFor(opts.market, c.id)]);
        const side = hist?.[c.hq ? 'hq' : 'nq'];
        const listings = (market[c.id]?.listings || [])
          .filter((l) => !!l.hq === c.hq && l.quantity > 0)
          .map((l) => ({ pricePerUnit: l.pricePerUnit, quantity: l.quantity, world: l.worldName || null, retainer: l.retainerName || null }))
          .sort((a, b) => a.pricePerUnit - b.pricePerUnit);
        // "Sold per week" is transactions: a stack of 33 is one sale. Units
        // still bound how much stock the market can absorb.
        if (side?.units && side.sales >= minWeek && listings.length) {
          const plan = planItem(listings, side.median, side.units, budget);
          if (plan) {
            plans.push({
              itemId: c.id, hq: c.hq, listings, median: side.median, avg: side.avg, soldWeek: side.sales, soldUnits: side.units, perDay: side.sales / 7,
              lastUpload: market[c.id]?.lastUploadTime || 0, ...plan, roi: plan.profit / plan.cost,
            });
          }
        }
      } catch (err) {
        console.error('[flip] verify failed:', err.message);
      }
      job.done++;
      await sleep(PAUSE_MS);
    }
  });
  await Promise.all(workers);

  // Spend the budget on the best return first; an item that does not fit is
  // re-planned with whatever is left, so smaller partial buys still count.
  job.phase = 'ranking';
  plans.sort((a, b) => b.roi - a.roi);
  let left = budget;
  const chosen = [];
  const skipped = [];
  for (const p of plans) {
    if (p.cost <= left) { chosen.push(p); left -= p.cost; continue; }
    const smaller = left >= p.listings[0].pricePerUnit * p.listings[0].quantity ? planItem(p.listings, p.median, p.soldUnits, left) : null;
    if (smaller) { chosen.push({ ...p, ...smaller, roi: smaller.profit / smaller.cost, partial: true }); left -= smaller.cost; }
    else skipped.push(p);
  }
  chosen.sort((a, b) => b.profit - a.profit);
  job.results = chosen;
  job.summary = {
    market: opts.market, budget, spend: budget - left, left, scope, minSoldWeek: minWeek, tax: SALE_TAX,
    profit: chosen.reduce((s, p) => s + p.profit, 0), revenue: chosen.reduce((s, p) => s + p.revenue, 0),
    candidates: ids.length, shortlisted: shortlist.length, viable: plans.length,
    overBudget: skipped.map((p) => ({ itemId: p.itemId, hq: p.hq, cost: p.cost, profit: p.profit })),
  };
  job.status = 'done';
  job.phase = 'done';
}
