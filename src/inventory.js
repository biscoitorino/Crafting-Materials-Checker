import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

/**
 * Inventory from an Allagan Tools CSV export (data/export.csv by default).
 *
 * Columns: Favourite?, Icon, Name, Type (NQ/HQ), Quantity/Total Quantity
 * Available, Source (character or retainer), Inventory Location. There are no
 * item IDs, so rows are matched to the index by name. Items that are listed
 * on the market, equipped, or in the armoury chest are not counted, since
 * they are not sitting there waiting to be crafted with.
 */

const EXCLUDED_LOCATIONS = /^(Market|Equipped Gear|Armory|Currency|Glamour)/i;

const csvPath = () => process.env.INVENTORY_CSV || path.join(config.dataDir, 'export.csv');

let cache = null; // { mtimeMs, byId: Map, summary }

/** Minimal CSV line splitter that copes with quoted fields. */
function splitCsv(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function parse(text, index) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return { byId: new Map(), summary: { rows: 0, matched: 0, characters: [] } };
  const header = splitCsv(lines[0]).map((h) => h.trim().toLowerCase());
  const col = (name) => header.findIndex((h) => h.startsWith(name));
  const iName = col('name');
  const iType = col('type');
  const iQty = col('quantity');
  const iSource = col('source');
  const iLoc = col('inventory location');
  if (iName < 0 || iQty < 0) throw new Error('unrecognised CSV header; expected an Allagan Tools export');

  const byName = new Map();
  for (const [id, it] of Object.entries(index.items)) byName.set(it.n.toLowerCase(), Number(id));

  const byId = new Map();
  const characters = new Set();
  let matched = 0;
  let skipped = 0;
  for (const line of lines.slice(1)) {
    const f = splitCsv(line);
    const name = (f[iName] || '').trim();
    const loc = (f[iLoc] || '').trim();
    if (!name) continue;
    if (EXCLUDED_LOCATIONS.test(loc)) { skipped++; continue; }
    const qty = Number.parseInt(String(f[iQty] || '').split('/')[0], 10) || 0;
    if (!qty) continue;
    const hq = /hq/i.test(f[iType] || '');
    const source = (f[iSource] || '').trim();
    if (source) characters.add(source);
    const id = byName.get(name.toLowerCase());
    if (!id) continue;
    matched++;
    if (!byId.has(id)) byId.set(id, { nq: 0, hq: 0, total: 0, where: [] });
    const e = byId.get(id);
    e[hq ? 'hq' : 'nq'] += qty;
    e.total += qty;
    e.where.push({ who: source, loc, qty, hq });
  }
  return { byId, summary: { rows: lines.length - 1, matched, skipped, items: byId.size, characters: [...characters] } };
}

/** Loads the CSV, re-reading it whenever the file changes. Returns null when absent. */
export function loadInventory(index) {
  const file = csvPath();
  let stat;
  try { stat = fs.statSync(file); } catch { cache = null; return null; }
  if (cache && cache.mtimeMs === stat.mtimeMs) return cache;
  const parsed = parse(fs.readFileSync(file, 'utf8'), index);
  cache = { mtimeMs: stat.mtimeMs, file, ...parsed };
  return cache;
}

export const inventoryPath = csvPath;
