/**
 * Stack-aware purchase planning.
 *
 * On the market board a listing is bought whole: you cannot take 10 out of a
 * stack of 99. So the cheapest way to get N units is not "cheapest price per
 * unit first" but the cheapest *set of listings* whose quantities add up to at
 * least N. That is a small knapsack, solved exactly here: with at most 100
 * listings and a few hundred units it is instant.
 */

const MAX_UNITS = 20_000;

/**
 * @param {Array<{pricePerUnit:number, quantity:number, hq:boolean, worldName?:string}>} listings
 * @param {number} need   units required
 * @param {'any'|'nq'|'hq'} quality
 */
export function planPurchase(listings, need, quality = 'any') {
  need = Math.max(0, Math.min(MAX_UNITS, Math.floor(need)));
  const pool = (listings || [])
    .filter((l) => l.quantity > 0 && l.pricePerUnit > 0)
    .filter((l) => quality === 'any' || (quality === 'hq') === !!l.hq)
    .map((l) => ({
      pricePerUnit: l.pricePerUnit, quantity: l.quantity, hq: !!l.hq,
      total: l.pricePerUnit * l.quantity, world: l.worldName || null, retainer: l.retainerName || null,
    }))
    .sort((a, b) => a.pricePerUnit - b.pricePerUnit || a.quantity - b.quantity);

  const available = pool.reduce((s, l) => s + l.quantity, 0);
  const cheapestUnit = pool.length ? pool[0].pricePerUnit : null;
  const base = { need, available, cheapestUnit, listings: pool.length, short: available < need };

  if (!need) return { ...base, plan: [], units: 0, cost: 0, leftover: 0 };
  if (!pool.length) return { ...base, plan: [], units: 0, cost: 0, leftover: 0 };

  // If the board cannot cover it, buy everything there is: that is the only
  // plan that gets closest, and the UI flags the shortfall.
  const target = Math.min(need, available);

  // dp[q] = minimum cost to have coverage of exactly q units, where q is capped
  // at `target` (anything beyond the target counts as target).
  const INF = Number.POSITIVE_INFINITY;
  let dp = new Float64Array(target + 1).fill(INF);
  dp[0] = 0;
  const from = []; // from[i][q] = previous coverage when listing i is taken to reach q, else -1
  for (let i = 0; i < pool.length; i++) {
    const { quantity, total } = pool[i];
    const prev = new Int32Array(target + 1).fill(-1);
    const next = Float64Array.from(dp);
    for (let q = 0; q <= target; q++) {
      if (dp[q] === INF) continue;
      const nq = Math.min(target, q + quantity);
      const cost = dp[q] + total;
      // Prefer the cheaper plan; on a tie prefer the one with fewer surplus
      // units, which falls out naturally since we scan q ascending.
      if (cost < next[nq]) { next[nq] = cost; prev[nq] = q; }
    }
    dp = next;
    from.push(prev);
  }

  // Walk back to recover which listings were taken.
  const chosen = [];
  let q = target;
  for (let i = pool.length - 1; i >= 0 && q > 0; i--) {
    // Each layer copies the previous one, so prev[q] >= 0 means listing i is
    // the one that produced the best cost for coverage q.
    const p = from[i][q];
    if (p >= 0) { chosen.push(pool[i]); q = p; }
  }
  chosen.reverse();

  const units = chosen.reduce((s, l) => s + l.quantity, 0);
  const cost = chosen.reduce((s, l) => s + l.total, 0);
  return { ...base, plan: chosen, units, cost, leftover: Math.max(0, units - need) };
}

/**
 * What the naive "cheapest per unit, buy whole stacks until covered" approach
 * would cost, for the comparison shown in the UI.
 */
export function greedyCost(listings, need, quality = 'any') {
  const pool = (listings || [])
    .filter((l) => l.quantity > 0 && l.pricePerUnit > 0)
    .filter((l) => quality === 'any' || (quality === 'hq') === !!l.hq)
    .sort((a, b) => a.pricePerUnit - b.pricePerUnit);
  let units = 0, cost = 0;
  for (const l of pool) {
    if (units >= need) break;
    units += l.quantity;
    cost += l.pricePerUnit * l.quantity;
  }
  return { units, cost };
}
