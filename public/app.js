/* global document, fetch, localStorage, location */
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const gil = (n) => (n == null ? '–' : Math.round(n).toLocaleString('en-US'));
const PAGE = 200;

const state = {
  meta: null, recipes: [], items: {}, byId: new Map(),
  job: 0, q: '', lvMin: null, lvMax: null, expert: false, rarity: new Set(),
  filtered: [], shown: PAGE,
  selected: null, world: null, units: 1, quality: 'any', noCrystals: false,
  priceReq: 0,
};

const store = (k, v) => { try { v === undefined ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* ignore */ } };
const read = (k) => { try { return localStorage.getItem(k); } catch { return null; } };

function setStatus(kind, text) {
  $('#status .dot').className = `dot ${kind}`;
  $('#statusText').textContent = text;
}

/* ---------- boot ---------- */
async function boot() {
  setStatus('', 'loading recipes…');
  const [meta, data] = await Promise.all([
    fetch('/api/meta').then((r) => r.json()),
    fetch('/api/recipes').then((r) => r.json()),
  ]);
  state.meta = meta;
  state.recipes = data.recipes;
  state.items = data.items;
  for (const r of state.recipes) state.byId.set(r.id, r);

  buildWorlds(meta);
  buildJobs(meta);
  buildRarity();
  buildProfile(meta);
  initFlip();
  showView(read('view') || 'recipes');
  state.job = Number(read('job') || 0);
  state.units = Number(read('units') || 1);
  state.quality = read('quality') || 'any';
  state.noCrystals = read('noCrystals') === '1';
  $('#units').value = state.units;
  $('#noCrystals').checked = state.noCrystals;
  syncJobChips();
  syncQuality();
  applyFilter();
  setStatus('ok', `${state.recipes.length.toLocaleString()} recipes`);

  const m = location.hash.match(/r=(\d+)/);
  if (m) select(Number(m[1]));
}

function buildWorlds(meta) {
  const sel = $('#world');
  const saved = read('world') || meta.defaultWorld;
  sel.innerHTML = '';
  for (const dc of meta.worlds) {
    const g = document.createElement('optgroup');
    g.label = `${dc.name} (${dc.region})`;
    const all = document.createElement('option');
    all.value = dc.name; all.textContent = `${dc.name} — whole data centre`;
    g.appendChild(all);
    for (const w of dc.worlds) {
      const o = document.createElement('option');
      o.value = w; o.textContent = w;
      g.appendChild(o);
    }
    sel.appendChild(g);
  }
  if (!meta.worlds.length) {
    const o = document.createElement('option'); o.value = saved; o.textContent = saved; sel.appendChild(o);
  }
  sel.value = saved;
  if (!sel.value) sel.selectedIndex = 0;
  state.world = sel.value;
  sel.addEventListener('change', () => { state.world = sel.value; store('world', sel.value); reprice(); });
}

function buildJobs(meta) {
  const box = $('#jobs');
  box.innerHTML = '';
  const mk = (id, abbr, name) => {
    const b = document.createElement('button');
    b.className = 'chip'; b.dataset.job = id; b.title = name;
    b.innerHTML = `<b>${esc(abbr)}</b>`;
    b.addEventListener('click', () => { state.job = Number(id); store('job', id); syncJobChips(); applyFilter(); });
    box.appendChild(b);
  };
  mk(0, 'All', 'All classes');
  for (const [id, j] of Object.entries(meta.jobs)) mk(id, j.abbr, j.name);
}
const RARITIES = [[1, 'Basic'], [2, 'Green'], [3, 'Blue'], [4, 'Purple'], [7, 'Aetherial']];
function buildRarity() {
  const box = $('#rarity');
  box.innerHTML = '';
  for (const [id, label] of RARITIES) {
    const b = document.createElement('button');
    b.className = `chip r${id}`; b.dataset.rarity = id; b.title = `${label} rarity — click to toggle, combine freely`;
    b.innerHTML = `<span class="sw"></span>${label}`;
    b.addEventListener('click', () => {
      if (state.rarity.has(id)) state.rarity.delete(id); else state.rarity.add(id);
      store('rarity', [...state.rarity].join(','));
      syncRarityChips(); applyFilter();
    });
    box.appendChild(b);
  }
  const saved = read('rarity');
  if (saved) state.rarity = new Set(saved.split(',').map(Number).filter(Boolean));
  syncRarityChips();
}
const syncRarityChips = () => document.querySelectorAll('#rarity .chip').forEach((b) => b.classList.toggle('on', state.rarity.has(Number(b.dataset.rarity))));
const syncJobChips = () => document.querySelectorAll('#jobs .chip').forEach((b) => b.classList.toggle('on', Number(b.dataset.job) === state.job));
const syncQuality = () => document.querySelectorAll('#quality button').forEach((b) => b.classList.toggle('on', b.dataset.q === state.quality));

/* ---------- views ---------- */
function showView(name) {
  $('#recipesView').hidden = name !== 'recipes';
  $('#finderView').hidden = name !== 'finder';
  $('#flipView').hidden = name !== 'flip';
  document.querySelectorAll('#views button').forEach((b) => b.classList.toggle('on', b.dataset.view === name));
  store('view', name);
}
$('#views').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-view]');
  if (b) showView(b.dataset.view);
});

/* ---------- profit finder ---------- */
const profile = {
  levels: JSON.parse(read('levels') || '{}'),
  books: new Set(JSON.parse(read('books') || '[]')),
};
const saveProfile = () => { store('levels', JSON.stringify(profile.levels)); store('books', JSON.stringify([...profile.books])); };

function buildProfile(meta) {
  const lv = $('#levels');
  lv.innerHTML = '';
  for (const [id, j] of Object.entries(meta.jobs)) {
    const l = document.createElement('label');
    l.innerHTML = `<span class="job">${esc(j.abbr)}</span><input type="number" min="0" max="100" value="${profile.levels[id] || 0}" title="${esc(j.name)}">`;
    l.querySelector('input').addEventListener('change', (e) => {
      profile.levels[id] = Math.max(0, Math.min(100, Number(e.target.value) || 0));
      e.target.value = profile.levels[id]; saveProfile();
    });
    lv.appendChild(l);
  }
  const box = $('#books');
  box.innerHTML = '';
  const byJob = {};
  for (const [id, b] of Object.entries(meta.books || {})) (byJob[b.job] ||= []).push({ id: Number(id), ...b });
  for (const [jobId, j] of Object.entries(meta.jobs)) {
    const list = (byJob[jobId] || []).sort((a, b) => a.id - b.id);
    if (!list.length) continue;
    const d = document.createElement('details');
    const owned = () => list.filter((b) => profile.books.has(b.id)).length;
    d.innerHTML = `<summary><span class="job">${esc(j.abbr)}</span>${esc(j.name)} <button class="all" data-all="1">all</button><button class="all" data-all="0">none</button><span class="n">${owned()}/${list.length}</span></summary>
      <div class="bl">${list.map((b) => `<label title="${b.recipes} recipes"><input type="checkbox" data-book="${b.id}" ${profile.books.has(b.id) ? 'checked' : ''}>${esc(b.name.replace(/^Master /, ''))}</label>`).join('')}</div>`;
    d.addEventListener('change', (e) => {
      const cb = e.target.closest('input[data-book]');
      if (!cb) return;
      if (cb.checked) profile.books.add(Number(cb.dataset.book)); else profile.books.delete(Number(cb.dataset.book));
      saveProfile(); d.querySelector('.n').textContent = `${owned()}/${list.length}`;
    });
    d.querySelector('summary').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-all]');
      if (!btn) return;
      e.preventDefault();
      const on = btn.dataset.all === '1';
      for (const b of list) { if (on) profile.books.add(b.id); else profile.books.delete(b.id); }
      d.querySelectorAll('input[data-book]').forEach((cb) => { cb.checked = on; });
      saveProfile(); d.querySelector('.n').textContent = `${owned()}/${list.length}`;
    });
    box.appendChild(d);
  }
  $('#scanUnits').value = read('scanUnits') ?? 1;
  $('#scanUnits').addEventListener('change', (e) => { e.target.value = Math.max(1, Math.min(999, Number(e.target.value) || 1)); store('scanUnits', e.target.value); });
  $('#minSold').value = read('minSold') ?? 5;
  $('#sellAs').value = read('sellAs') || 'nq';
  $('#sortBy').value = read('sortBy') || 'profit';
  $('#scanExpert').checked = read('scanExpert') === '1';
  $('#minSold').addEventListener('change', (e) => store('minSold', e.target.value));
  $('#sellAs').addEventListener('change', (e) => store('sellAs', e.target.value));
  $('#sortBy').addEventListener('change', (e) => store('sortBy', e.target.value));
  $('#scanExpert').addEventListener('change', (e) => store('scanExpert', e.target.checked ? '1' : '0'));
  $('#scan').addEventListener('click', runScan);

  $('#mode').value = read('mode') || 'buy';
  $('#useInv').checked = read('useInv') === '1';
  $('#mode').addEventListener('change', (e) => { store('mode', e.target.value); syncMode(); });
  $('#useInv').addEventListener('change', (e) => { store('useInv', e.target.checked ? '1' : '0'); syncMode(); reprice(); });
  refreshInventory();
  syncMode();
}

function syncMode() {
  const mode = $('#mode').value;
  const needsInv = mode !== 'buy';
  if (needsInv && !$('#useInv').checked) { $('#useInv').checked = true; store('useInv', '1'); }
  $('#sortBy').closest('label').hidden = mode !== 'buy';
  $('#scanUnitsRow').hidden = mode !== 'buy';
  $('#sellAs').closest('label').hidden = mode === 'sell';
}

async function refreshInventory() {
  const el = $('#invStatus');
  try {
    const inv = await fetch('/api/inventory', { cache: 'no-store' }).then((r) => r.json());
    state.inventory = inv;
    if (!inv.present) {
      el.innerHTML = `No export found. Save an Allagan Tools CSV export to <code>${esc(inv.file)}</code>. <a class="link" id="invReload">check again</a>`;
    } else {
      const when = new Date(inv.updatedAt);
      el.innerHTML = `${inv.items} items (${inv.matched} stacks) from ${inv.characters.map(esc).join(', ')} · exported ${when.toLocaleDateString()} ${when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} <a class="link" id="invReload">reload</a>`;
    }
    el.querySelector('#invReload')?.addEventListener('click', refreshInventory);
  } catch (err) {
    el.textContent = `Inventory unavailable: ${err.message}`;
  }
}

async function runScan() {
  const btn = $('#scan');
  const status = $('#scanStatus');
  const out = $('#finderResults');
  const mode = $('#mode').value;
  if (mode !== 'sell' && !Object.values(profile.levels).some((v) => v > 0)) {
    status.textContent = 'Set at least one class level first.';
    return;
  }
  if (mode !== 'buy' && !state.inventory?.present) {
    status.textContent = 'This mode needs an inventory export (see above).';
    return;
  }
  btn.disabled = true;
  out.innerHTML = '<div class="spinner">Starting scan…</div><div class="progress"><i style="width:0"></i></div>';
  try {
    const res = await fetch('/api/scan', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        market: state.world, levels: profile.levels, books: [...profile.books],
        expert: $('#scanExpert').checked, minSoldWeek: Number($('#minSold').value) || 0,
        sellAs: $('#sellAs').value, sortBy: $('#sortBy').value, ignoreCrystals: state.noCrystals,
        mode: $('#mode').value, useInventory: $('#useInv').checked, units: Number($('#scanUnits').value) || 1,
      }),
    });
    const { id } = await res.json();
    for (;;) {
      await new Promise((r) => setTimeout(r, 700));
      const job = await fetch(`/api/scan/${id}`).then((r) => r.json());
      if (job.status === 'error') throw new Error(job.error || 'scan failed');
      const phase = { preparing: 'Preparing', sales: 'Checking what sells', materials: 'Pricing materials', ranking: 'Ranking', verifying: 'Checking live listings for the best ones', done: 'Done' }[job.phase] || job.phase;
      const pct = job.total ? Math.round((job.done / job.total) * 100) : 0;
      status.textContent = `${phase}… ${job.candidates ? `${job.candidates.toLocaleString()} recipes you can make` : ''}`;
      const bar = out.querySelector('.progress i');
      if (bar) bar.style.width = `${pct}%`;
      const sp = out.querySelector('.spinner');
      if (sp) sp.textContent = `${phase}… ${job.total ? `${job.done}/${job.total} items` : ''}`;
      if (job.status === 'done') { renderScan(job); break; }
    }
  } catch (err) {
    out.innerHTML = `<div class="spinner bad">Scan failed: ${esc(err.message)}</div>`;
    status.textContent = '';
  } finally {
    btn.disabled = false;
  }
}

function renderScan(job) {
  const s = job.summary;
  const out = $('#finderResults');
  if (s.mode === 'sell') return renderSellScan(job);
  if (s.mode === 'own') return renderOwnScan(job);
  $('#scanStatus').textContent = `${s.priced} recipes priced · ${s.selling} sell at least ${$('#minSold').value}/week of ${s.candidates} you can make`;
  if (!job.results.length) {
    out.innerHTML = '<div class="empty"><p>Nothing matched.</p><p class="hint">Lower the minimum sold per week, tick more books, or raise your levels.</p></div>';
    return;
  }
  const pct = (n) => (n == null ? '–' : `${Math.round(n * 100)}%`);
  const per = (n) => (n >= 10 ? n.toFixed(0) : n >= 1 ? n.toFixed(1) : n.toFixed(2));
  const stars = (n) => '\u2605'.repeat(n);
  let dividerDone = false;
  const rows = job.results.map((r, i) => {
    const it = state.items[r.itemId] || {};
    const jb = state.meta.jobs[r.job] || {};
    let divider = '';
    if (!r.verified && !dividerDone) {
      dividerDone = true;
      divider = `<tr class="divider"><td colspan="10">Below: estimates from the cheapest listing per material, not yet checked against live stacks. Click one to price it exactly.</td></tr>`;
    }
    const mats = r.mats.map((m) => `${m.amount}x ${esc(state.items[m.id]?.n || m.id)}${m.source === 'vendor' ? ' (NPC)' : m.source === 'owned' ? ' <span class="good">(owned)</span>' : m.have ? ` <span class="good">(have ${m.have})</span>` : ''}`).join(', ');
    return `${divider}<tr data-id="${r.recipeId}" class="${r.verified ? '' : 'est'}" title="Open the recipe for the exact stack-by-stack cost">
      <td class="num pos">${i + 1}</td>
      <td><span class="iname"><img class="ico sm" loading="lazy" src="/icon/${r.itemId}" alt=""><span><span class="r${it.q || 1}">${esc(it.n)}</span><br><span class="mats">${mats}</span></span></span></td>
      <td><span class="job">${esc(jb.abbr)}</span> ${r.lvl}<span class="stars">${stars(r.stars)}</span></td>
      <td class="num">${gil(r.sellAt)}<br><span class="mut" title="${r.verified ? 'Median of this week&#39;s sales, capped at the cheapest current listing' : 'Weekly average, capped at the cheapest current listing'}">${r.verified ? 'median' : 'avg'}${r.capped ? ', capped' : ''}${r.sellAvg && Math.round(r.sellAvg) !== Math.round(r.sellAt) ? ` · avg ${gil(r.sellAvg)}` : ''}</span></td>
      <td class="num">${per(r.soldWeek)}<br><span class="mut">${r.salesKnown ? `${per(r.perDay)}/day · ${per(r.soldUnits)} units` : 'units (estimate)'}</span></td>
      <td class="num">${gil(r.costPerUnit)}${r.yields > 1 ? `<br><span class="mut">${gil(r.costPerCraft)} / ${r.yields}</span>` : ''}<br><span class="${r.verified ? 'good' : 'mut'}" style="font-size:11px">${r.verified ? 'live stacks' : 'estimate'}</span></td>
      <td class="num ${r.profit >= 0 ? 'good' : 'bad'}">${gil(r.profit)}</td>
      <td class="num">${pct(r.margin)}</td>
      ${s.units > 1 ? `<td class="num ${r.batchProfit >= 0 ? 'good' : 'bad'}">${gil(r.batchProfit)}<br><span class="mut">${r.units} units, cost ${gil(r.batchCost)}</span>${r.overDemand ? `<br><span class="warn" title="The whole market sold fewer than this in the last week; expect to sit on some">more than a week of sales</span>` : ''}</td>` : ''}
      <td class="num ${r.weekly >= 0 ? 'good' : 'bad'}">${gil(r.weekly)}</td>
    </tr>`;
  }).join('');
  out.innerHTML = `
    <div class="sheet tbl">
      <table class="rank">
        <thead><tr><th></th><th>Recipe</th><th>Class</th><th class="num">Sells at<br><span class="mut">${s.sellAs.toUpperCase()}</span></th><th class="num">Sales / week<br><span class="mut">a stack is one sale</span></th><th class="num">Materials<br><span class="mut">per unit</span></th><th class="num">Profit<br><span class="mut">per unit</span></th><th class="num">Margin</th>${s.units > 1 ? `<th class="num">Batch of ${s.units}<br><span class="mut">total profit</span></th>` : ''}<th class="num">Weekly<br><span class="mut">potential</span></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="note">Priced on ${esc(s.market)}${s.units > 1 ? `, for a batch of ${s.units} units (material stacks and owned materials are worked out for the whole batch)` : ''}. Profit = sale price (the weekly average, capped at the current cheapest listing since that is what you must undercut) minus ${Math.round(s.tax * 100)}% market tax minus materials, using the cheapest current listing or the NPC price for each material. Weekly potential is that profit times how many units the whole market sells per week, so it is a ceiling, not a promise. Click a row for the exact stack-by-stack cost.
      ${s.verified} candidates were re-priced against live listings and the week's sale history (median price, marked <span class="good">live stacks</span>); those come first.
      ${s.unmakeable?.length ? `<br><span class="bad">Dropped ${s.unmakeable.length} that cannot be made right now</span> because a material is not on the board in the needed quantity, or the week's history shows fewer sales than the aggregate claimed: ${s.unmakeable.map((u) => `${esc(state.items[u.itemId]?.n || u.itemId)} <span class="mut">(${u.missing.length ? 'missing ' + u.missing.map((m) => esc(state.items[m]?.n || m)).join(', ') : esc(u.reason || '')})</span>`).join('; ')}.` : ''}</p>`;
  out.querySelector('tbody').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    showView('recipes');
    select(Number(tr.dataset.id));
  });
}

function renderOwnScan(job) {
  const s = job.summary;
  const out = $('#finderResults');
  $('#scanStatus').textContent = `${s.priced} recipes you can make right now from your bags · ${s.selling} sell at least ${$('#minSold').value}/week`;
  if (!job.results.length) {
    out.innerHTML = '<div class="empty"><p>Nothing craftable from your inventory sells enough.</p><p class="hint">Lower the minimum sold per week, or switch to "Craft to sell" to include recipes you would need to shop for.</p></div>';
    return;
  }
  const per = (n) => (n >= 10 ? n.toFixed(0) : n >= 1 ? n.toFixed(1) : n.toFixed(2));
  const stars = (n) => '\u2605'.repeat(n);
  const rows = job.results.map((r, i) => {
    const it = state.items[r.itemId] || {};
    const jb = state.meta.jobs[r.job] || {};
    const mats = r.mats.map((m) => `${m.amount}x ${esc(state.items[m.id]?.n || m.id)} <span class="mut">(have ${m.have})</span>`).join(', ');
    const revenue = r.sellAt * (1 - s.tax) * r.yields;
    const perCraftGain = revenue - r.rawValuePerCraft;
    const allUnits = r.crafts * r.yields;
    const allRevenue = revenue * r.crafts;
    const weeks = r.soldUnits > 0 ? allUnits / r.soldUnits : null;
    return `<tr data-id="${r.recipeId}" class="${r.verified ? '' : 'est'}">
      <td class="num pos">${i + 1}</td>
      <td><span class="iname"><img class="ico sm" loading="lazy" src="/icon/${r.itemId}" alt=""><span><span class="r${it.q || 1}">${esc(it.n)}</span><br><span class="mats">${mats}</span></span></span></td>
      <td><span class="job">${esc(jb.abbr)}</span> ${r.lvl}<span class="stars">${stars(r.stars)}</span></td>
      <td class="num">${r.crafts}<br><span class="mut">${allUnits} unit${allUnits === 1 ? '' : 's'}</span></td>
      <td class="num">${gil(r.sellAt)}<br><span class="mut">${r.verified ? 'median' : 'avg'}${r.capped ? ', capped' : ''}</span></td>
      <td class="num good">${gil(allRevenue)}<br><span class="${weeks != null && weeks > 1 ? 'warn' : 'mut'}" title="${weeks != null ? `At ${r.soldUnits.toFixed(0)} units sold per week on the whole market, ${allUnits} units is about ${weeks.toFixed(1)} week${weeks >= 1.5 ? 's' : ''} of demand` : ''}">${weeks == null ? 'no sales data' : weeks <= 1 ? 'within a week of demand' : `≈ ${weeks.toFixed(1)} weeks to sell`}</span></td>
      <td class="num">${per(r.soldWeek)}<br><span class="mut">${r.salesKnown ? `${per(r.perDay)}/day · ${per(r.soldUnits)} units` : 'units (estimate)'}</span></td>
      <td class="num">${gil(r.rawValuePerCraft)}</td>
      <td class="num ${perCraftGain >= 0 ? 'good' : 'bad'}">${gil(perCraftGain)}</td>
      <td class="num ${r.gain >= 0 ? 'good' : 'bad'}">${gil(r.gain)}</td>
    </tr>`;
  }).join('');
  out.innerHTML = `
    <div class="sheet tbl">
      <table class="rank">
        <thead><tr><th></th><th>Recipe</th><th>Class</th><th class="num">Can craft</th><th class="num">Sells at<br><span class="mut">${(s.sellAs || 'nq').toUpperCase()}</span></th><th class="num">Craft all &amp; sell<br><span class="mut">after tax</span></th><th class="num">Sales / week<br><span class="mut">a stack is one sale</span></th><th class="num">Materials<br><span class="mut">raw value / craft</span></th><th class="num">Crafting adds<br><span class="mut">per craft</span></th><th class="num">Total gain<br><span class="mut">realistic</span></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="note">"Craft all &amp; sell" is what you would take home (after ${Math.round(s.tax * 100)}% tax) if you crafted every unit your bags allow and sold them all at the price shown; the line under it says how long that many units would take to move at the market's current pace. Only recipes whose every material is already in your bags (${s.usedInventory ? 'per the export' : ''}). "Crafting adds" is the sale after ${Math.round(s.tax * 100)}% tax minus what the materials would fetch sold raw, so a negative number means sell the materials instead. "Total gain" multiplies that by how many you can craft, capped at roughly a week of market demand. Rows marked live were checked against the week's sale history.</p>`;
  out.querySelector('tbody').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    showView('recipes');
    select(Number(tr.dataset.id));
  });
}

function renderSellScan(job) {
  const s = job.summary;
  const out = $('#finderResults');
  const total = job.results.reduce((a, r) => a + r.value, 0);
  $('#scanStatus').textContent = `${s.priced} stacks worth selling · ${gil(total)} gil in total`;
  if (!job.results.length) {
    out.innerHTML = '<div class="empty"><p>Nothing in your bags sells enough on this market.</p><p class="hint">Lower the minimum sold per week.</p></div>';
    return;
  }
  const per = (n) => (n >= 10 ? n.toFixed(0) : n >= 1 ? n.toFixed(1) : n.toFixed(2));
  const rows = job.results.map((r, i) => {
    const it = state.items[r.itemId] || {};
    const where = r.where.map((w) => `${esc(w.who)}: ${esc(w.loc)} (${w.qty})`).join(', ');
    return `<tr data-item="${r.itemId}" class="${r.verified ? '' : 'est'}">
      <td class="num pos">${i + 1}</td>
      <td><span class="iname"><img class="ico sm" loading="lazy" src="/icon/${r.itemId}" alt=""><span><span class="r${it.q || 1}">${esc(it.n)}</span>${r.hq ? ' <span class="hq">HQ</span>' : ''}<br><span class="mats">${where}</span></span></span></td>
      <td class="num">${r.qty}</td>
      <td class="num">${gil(r.sellAt)}<br><span class="mut">${r.verified ? 'median' : 'avg'}${r.capped ? ', capped' : ''}</span></td>
      <td class="num">${per(r.soldWeek)}<br><span class="mut">${r.salesKnown ? `${per(r.perDay)}/day · ${per(r.soldUnits)} units` : 'units (estimate)'}</span></td>
      <td class="num good">${gil(r.value)}</td>
    </tr>`;
  }).join('');
  out.innerHTML = `
    <div class="sheet tbl">
      <table class="rank">
        <thead><tr><th></th><th>Item</th><th class="num">You have</th><th class="num">Sells at</th><th class="num">Sales / week<br><span class="mut">a stack is one sale</span></th><th class="num">Value<br><span class="mut">after tax</span></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="note">Everything marketable in your bags and retainers (not counting what is already listed), valued at the price you could realistically sell for on ${esc(s.market)}: the week's median sale, capped at the cheapest current listing, minus ${Math.round(s.tax * 100)}% tax. The top ${s.verified} were checked against full sale history; the rest use Universalis' weekly average.</p>`;
  out.querySelector('tbody').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-item]');
    if (!tr) return;
    const rid = state.items[tr.dataset.item]?.r?.[0];
    if (rid) { showView('recipes'); select(rid); }
  });
}

/* ---------- flipping ---------- */
function initFlip() {
  $('#flipBudget').value = read('flipBudget') ?? 100000;
  $('#flipMinSold').value = read('flipMinSold') ?? 5;
  $('#flipScope').value = read('flipScope') || 'all';
  $('#flipBudget').addEventListener('change', (e) => store('flipBudget', e.target.value));
  $('#flipMinSold').addEventListener('change', (e) => store('flipMinSold', e.target.value));
  $('#flipScope').addEventListener('change', (e) => store('flipScope', e.target.value));
  $('#flipScan').addEventListener('click', runFlip);
}

async function runFlip() {
  const btn = $('#flipScan');
  const status = $('#flipStatus');
  const out = $('#flipResults');
  btn.disabled = true;
  out.innerHTML = '<div class="spinner">Starting…</div><div class="progress"><i style="width:0"></i></div>';
  try {
    const res = await fetch('/api/flip', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        market: state.world, budget: Number($('#flipBudget').value) || 100000,
        minSoldWeek: Number($('#flipMinSold').value) || 5, scope: $('#flipScope').value, ignoreCrystals: state.noCrystals,
      }),
    });
    const { id } = await res.json();
    for (;;) {
      await new Promise((r) => setTimeout(r, 700));
      const job = await fetch(`/api/flip/${id}`).then((r) => r.json());
      if (job.status === 'error') throw new Error(job.error || 'scan failed');
      const phase = { preparing: 'Preparing', sales: 'Reading market stats', verifying: 'Checking live listings', ranking: 'Allocating budget', done: 'Done' }[job.phase] || job.phase;
      const pct = job.total ? Math.round((job.done / job.total) * 100) : 0;
      status.textContent = `${phase}… ${job.candidates ? `${job.candidates.toLocaleString()} items` : ''}`;
      const bar = out.querySelector('.progress i');
      if (bar) bar.style.width = `${pct}%`;
      const sp = out.querySelector('.spinner');
      if (sp) sp.textContent = `${phase}… ${job.total ? `${job.done}/${job.total}` : ''}`;
      if (job.status === 'done') { renderFlip(job); break; }
    }
  } catch (err) {
    out.innerHTML = `<div class="spinner bad">Failed: ${esc(err.message)}</div>`;
    status.textContent = '';
  } finally {
    btn.disabled = false;
  }
}

function renderFlip(job) {
  const s = job.summary;
  const out = $('#flipResults');
  const per = (n) => (n >= 10 ? n.toFixed(0) : n >= 1 ? n.toFixed(1) : n.toFixed(2));
  $('#flipStatus').textContent = `${job.results.length} flips · ${s.viable} viable of ${s.shortlisted} checked (${s.candidates.toLocaleString()} items scanned)`;
  if (!job.results.length) {
    out.innerHTML = '<div class="empty"><p>No worthwhile flips right now.</p><p class="hint">Try a lower minimum sold per week, a bigger budget, or the whole data centre as the market.</p></div>';
    return;
  }
  const rows = job.results.map((r, i) => {
    const it = state.items[r.itemId] || {};
    const buys = r.buys.map((l) => `<span class="stack ${r.hq ? 'hq' : ''}" title="${l.retainer ? esc(l.retainer) + ' · ' : ''}${l.quantity} × ${gil(l.pricePerUnit)} = ${gil(l.pricePerUnit * l.quantity)}">${l.quantity} × ${gil(l.pricePerUnit)}${l.world ? ` <span class="w">${esc(l.world)}</span>` : ''}</span>`).join('');
    const next = r.listings[r.buys.length];
    const weeks = r.units / r.soldUnits;
    const age = ageText(r.lastUpload);
    return `<tr data-item="${r.itemId}">
      <td class="num pos">${i + 1}</td>
      <td><span class="iname"><img class="ico sm" loading="lazy" src="/icon/${r.itemId}" alt=""><span><span class="r${it.q || 1}">${esc(it.n)}</span>${r.hq ? ' <span class="hq">HQ</span>' : ''}${r.partial ? ' <span class="mut">(partial, budget)</span>' : ''}<br><span class="mats">${esc(it.c || '')}</span></span></span></td>
      <td><div class="plan">${buys}</div><div class="vendors">${next ? `next listing after yours: ${gil(next.pricePerUnit)}` : 'no other listings left'}</div></td>
      <td class="num">${r.units}<br><span class="mut">${gil(r.cost)}</span></td>
      <td class="num">${gil(r.resell)}<br><span class="mut" title="Median of this week's sales">median ${gil(r.median)}</span></td>
      <td class="num">${per(r.soldWeek)}<br><span class="${weeks > 1 ? 'warn' : 'mut'}">${weeks <= 1 ? `${per(r.perDay)}/day · ${per(r.soldUnits)} units` : `≈ ${weeks.toFixed(1)} weeks to sell`}</span></td>
      <td class="num good">${gil(r.profit)}<br><span class="mut">${Math.round(r.roi * 100)}% return</span></td>
      <td><span class="age ${age.old ? 'old' : ''}">${age.text}</span></td>
    </tr>`;
  }).join('');
  out.innerHTML = `
    <div class="totals">
      <div class="card"><div class="k">Spend</div><div class="n">${gil(s.spend)}</div><div class="d">of ${gil(s.budget)} budget · ${gil(s.left)} unspent</div></div>
      <div class="card"><div class="k">Expected profit</div><div class="n good">${gil(s.profit)}</div><div class="d">after ${Math.round(s.tax * 100)}% tax · ${Math.round((s.profit / Math.max(1, s.spend)) * 100)}% return</div></div>
      <div class="card"><div class="k">Resale revenue</div><div class="n small">${gil(s.revenue)}</div><div class="d">${job.results.reduce((a, r) => a + r.units, 0)} units across ${job.results.length} items</div></div>
    </div>
    <div class="sheet tbl">
      <table class="rank">
        <thead><tr><th></th><th>Item</th><th>Buy these listings</th><th class="num">Units<br><span class="mut">cost</span></th><th class="num">Relist at</th><th class="num">Sales / week<br><span class="mut">a stack is one sale</span></th><th class="num">Profit</th><th>Board data</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="note">Priced on ${esc(s.market)}. Each row buys the cheapest listings whole and relists at the week's median sale price, or just under the cheapest listing left behind if that is lower, since it becomes your competition. Nothing plans more units than the market sold in the last week. Board data age matters here more than anywhere: a cheap listing from hours ago may already be gone, so check in game before buying.
      ${s.overBudget.length ? `<br><span class="mut">Would also work with more budget: ${s.overBudget.slice(0, 8).map((o) => `${esc(state.items[o.itemId]?.n || o.itemId)}${o.hq ? ' HQ' : ''} (${gil(o.cost)} for +${gil(o.profit)})`).join(', ')}.</span>` : ''}</p>`;
  out.querySelector('tbody').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-item]');
    if (!tr) return;
    const rid = state.items[tr.dataset.item]?.r?.[0];
    if (rid) { showView('recipes'); select(rid); }
  });
}

/* ---------- data updates ---------- */
function ago(iso) {
  if (!iso) return '';
  const d = Math.round((Date.now() - new Date(iso).getTime()) / 86400000);
  return d <= 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`;
}
async function reloadRecipes() {
  const data = await fetch('/api/recipes', { cache: 'reload' }).then((r) => r.json());
  const meta = await fetch('/api/meta', { cache: 'reload' }).then((r) => r.json());
  state.meta = meta;
  state.recipes = data.recipes;
  state.items = data.items;
  state.byId = new Map(state.recipes.map((r) => [r.id, r]));
  applyFilter();
  if (state.selected) select(state.selected.id);
}
$('#quitApp').addEventListener('click', async () => {
  $('#quitApp').disabled = true;
  try { await fetch('/api/quit', { method: 'POST' }); } catch { /* it stops mid-reply */ }
  const panel = document.createElement('div');
  panel.className = 'stopped';
  panel.innerHTML = `<div>
    <h2>Crafting Materials Checker has stopped</h2>
    <p>You can close this tab.</p>
    <p class="hint">Start it again from the shortcut whenever you need it.</p>
  </div>`;
  document.body.appendChild(panel);
});

$('#dataCheck').addEventListener('click', async () => {
  const btn = $('#dataCheck');
  const out = $('#dataText');
  btn.disabled = true;
  out.textContent = 'checking…';
  try {
    const c = await fetch('/api/data/check', { cache: 'no-store' }).then((r) => r.json());
    if (c.error) throw new Error(c.error);
    if (c.upToDate) {
      out.innerHTML = `<span class="good" title="Teamcraft data from ${ago(c.latest.date)} (${esc(c.latest.message)}); index built ${ago(c.builtAt)}">up to date</span>`;
      out.title = '';
      return;
    }
    out.innerHTML = `<span class="warn" title="${esc(c.latest.message)}, ${ago(c.latest.date)}">newer data</span> <a class="link" id="dataUpdate">download</a>`;
    out.querySelector('#dataUpdate').addEventListener('click', async () => {
      out.textContent = 'downloading ~30 MB and rebuilding…';
      const r = await fetch('/api/data/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then((r) => r.json());
      if (!r.started) { out.textContent = r.reason; return; }
      for (;;) {
        await new Promise((res) => setTimeout(res, 1500));
        const st = await fetch('/api/data/status', { cache: 'no-store' }).then((r) => r.json());
        if (st.status === 'error') { out.innerHTML = `<span class="bad">update failed: ${esc(st.error)}</span>`; return; }
        if (st.status === 'done') {
          await reloadRecipes();
          out.innerHTML = `<span class="good" title="${st.recipes.toLocaleString()} recipes, built just now">updated</span>`;
          setStatus('ok', `${st.recipes.toLocaleString()} recipes`);
          return;
        }
        out.textContent = 'rebuilding…';
      }
    });
  } catch (err) {
    out.innerHTML = `<span class="bad">${esc(err.message)}</span>`;
  } finally {
    btn.disabled = false;
  }
});

/* ---------- filtering ---------- */
function applyFilter() {
  const q = state.q.trim().toLowerCase();
  const words = q ? q.split(/\s+/) : [];
  state.filtered = state.recipes.filter((r) => {
    if (state.job && r.job !== state.job) return false;
    if (state.lvMin && r.lvl < state.lvMin) return false;
    if (state.lvMax && r.lvl > state.lvMax) return false;
    if (state.expert && !r.expert) return false;
    if (state.rarity.size && !state.rarity.has(state.items[r.result]?.q || 1)) return false;
    if (words.length) {
      const n = (state.items[r.result]?.n || '').toLowerCase();
      if (!words.every((w) => n.includes(w))) return false;
    }
    return true;
  });
  state.shown = PAGE;
  renderList();
}

function renderList() {
  const list = $('#list');
  const rows = state.filtered.slice(0, state.shown);
  list.innerHTML = rows.map((r) => {
    const it = state.items[r.result] || {};
    const job = state.meta.jobs[r.job]?.abbr || '?';
    return `<li data-id="${r.id}" class="${state.selected?.id === r.id ? 'on' : ''}">
      <img class="ico" loading="lazy" src="/icon/${r.result}" alt="">
      <span class="nm r${it.q || 1}">${esc(it.n)}</span>
      <span class="meta"><span class="job">${job}</span> ${r.lvl}<span class="stars">${'★'.repeat(r.stars)}</span></span>
    </li>`;
  }).join('');
  $('#count').textContent = `${state.filtered.length.toLocaleString()} recipe${state.filtered.length === 1 ? '' : 's'}`;
  $('#more').hidden = state.shown >= state.filtered.length;
}

$('#list').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-id]');
  if (li) select(Number(li.dataset.id));
});
$('#more').addEventListener('click', () => { state.shown += PAGE; renderList(); });
let searchTimer;
$('#search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.q = e.target.value; applyFilter(); }, 120);
});
$('#lvMin').addEventListener('input', (e) => { state.lvMin = Number(e.target.value) || null; applyFilter(); });
$('#lvMax').addEventListener('input', (e) => { state.lvMax = Number(e.target.value) || null; applyFilter(); });
$('#expert').addEventListener('change', (e) => { state.expert = e.target.checked; applyFilter(); });
$('#units').addEventListener('change', (e) => {
  state.units = Math.max(1, Math.min(9999, Number(e.target.value) || 1));
  e.target.value = state.units; store('units', state.units); reprice();
});
$('#noCrystals').addEventListener('change', (e) => {
  state.noCrystals = e.target.checked; store('noCrystals', state.noCrystals ? '1' : '0'); reprice();
});
$('#quality').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-q]');
  if (!b) return;
  state.quality = b.dataset.q; store('quality', state.quality); syncQuality(); reprice();
});
window.addEventListener('hashchange', () => {
  const m = location.hash.match(/r=(\d+)/);
  if (m && Number(m[1]) !== state.selected?.id) select(Number(m[1]));
});

/* ---------- detail ---------- */
function select(id) {
  const r = state.byId.get(id);
  if (!r) return;
  state.selected = r;
  if (location.hash !== `#r=${id}`) history.replaceState(null, '', `#r=${id}`);
  document.querySelectorAll('#list li').forEach((li) => li.classList.toggle('on', Number(li.dataset.id) === id));
  renderDetail(r, null);
  reprice();
}

function ageText(ts) {
  if (!ts) return { text: 'never uploaded', old: true };
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return { text: 'just now', old: false };
  if (mins < 60) return { text: `${mins} min ago`, old: false };
  const h = Math.round(mins / 60);
  if (h < 48) return { text: `${h} h ago`, old: h > 12 };
  return { text: `${Math.round(h / 24)} d ago`, old: true };
}

function sheetHtml(r) {
  const it = state.items[r.result] || {};
  const job = state.meta.jobs[r.job] || {};
  const kv = (rows) => `<div class="kv">${rows.map(([k, v]) => `<div>${k}</div><div>${v}</div>`).join('')}</div>`;
  const ingList = r.ingredients.map((i) => {
    const ii = state.items[i.id] || {};
    const name = ii.r?.length ? `<a href="#r=${ii.r[0]}" title="This material is craftable. Open its recipe.">${esc(ii.n)}</a>` : esc(ii.n);
    const npc = ii.v ? ` <span class="npc" title="Sold by an NPC for ${gil(ii.v.p)} gil">NPC</span>` : '';
    return `<li><span class="amt">${i.amount}</span><img class="ico sm" loading="lazy" src="/icon/${i.id}" alt="">${name}${npc}</li>`;
  }).join('');
  return `<div class="sheet">
    <h3>${esc(it.n)}</h3>
    ${kv([
      ['Source', 'Class'],
      ['Type', esc(it.c || '—')],
      ['Class', `<span class="job">${esc(job.abbr)}</span> ${esc(job.name || '')}`],
      ['Level', `${r.lvl} <span class="stars">${'★'.repeat(r.stars)}</span> <span class="mut">(rlvl ${r.rlvl})</span>`],
      ['Durability', r.durability],
      ['Difficulty', r.progress],
      ['Max quality', r.quality],
      ['Yield', r.yields],
      ...(it.g ? [['Expert delivery', `<span class="seal">${gil(it.g)}</span> seals <span class="mut">(ilvl ${it.l})</span>`]] : []),
    ])}
    <h3>Characteristics</h3>
    ${kv([
      ['Quick Synthesis', r.qs ? 'Available' : '<span class="mut">Not available</span>'],
      ['High Quality', r.hq ? 'Available' : '<span class="mut">Not available</span>'],
      ['Craftsmanship rec.', r.suggestedCraftsmanship || '—'],
      ...(r.craftsmanshipReq ? [['Craftsmanship req.', r.craftsmanshipReq]] : []),
      ...(r.controlReq ? [['Control req.', r.controlReq]] : []),
      ...(r.requiredQuality ? [['Required quality', r.requiredQuality]] : []),
      ...(r.expert ? [['Expert recipe', '<span class="warn">Yes</span>']] : []),
    ])}
    <h3>Ingredients</h3>
    <ul class="ing">${ingList}</ul>
  </div>`;
}

function renderDetail(r, price) {
  const it = state.items[r.result] || {};
  const job = state.meta.jobs[r.job] || {};
  const alts = (it.r || []).filter((id) => id !== r.id);
  $('#detail').innerHTML = `
    <div class="head">
      <img class="ico" src="/icon/${r.result}" alt="">
      <div>
        <h2 class="r${it.q || 1}">${esc(it.n)}</h2>
        <div class="sub">${esc(job.name)} · Lv ${r.lvl}${'★'.repeat(r.stars)} · ${esc(it.c || '')}
          ${it.m === false ? ' · <span class="warn">not marketable</span>' : ''}
          ${alts.length ? ` · ${alts.map((id) => `<a class="link" href="#r=${id}">alt. recipe (${esc(state.meta.jobs[state.byId.get(id)?.job]?.abbr || '?')})</a>`).join(' ')}` : ''}
        </div>
      </div>
    </div>
    <div class="grid">
      ${sheetHtml(r)}
      <div id="pricing">${price ? pricingHtml(r, price) : '<div class="spinner">Fetching listings from Universalis…</div>'}</div>
    </div>`;
}

function vendorsHtml(v) {
  const list = v.npcs.map((n) => `<b>${esc(n.n)}</b>${n.t ? ` <span class="mut">(${esc(n.t)})</span>` : ''}${n.z ? ` · ${esc(n.z)} <span class="coord">${n.x}, ${n.y}</span>` : ''}`);
  const [first, ...rest] = list;
  return `<div class="vendors" title="${esc(v.npcs.map((n) => `${n.n}${n.z ? ` — ${n.z} (${n.x}, ${n.y})` : ''}`).join(' | '))}">${first}${rest.length ? ` <span class="mut">+${rest.length} more</span>` : ''}</div>`;
}

function planHtml(ing) {
  if (ing.source === 'owned') return '<span class="good">already in your bags</span>';
  const v = ing.vendor;
  if (ing.source === 'vendor') {
    const p = ing.plan;
    const boardNote = ing.marketable && p?.listings
      ? `<span class="mut">board would be ${gil(p.cost)}${p.short ? ' and short' : ''}</span>`
      : ing.marketable ? '<span class="mut">no board listings</span>' : '';
    return `<div class="plan"><span class="stack vendor" title="Buy exactly ${ing.need} from an NPC vendor">${ing.need} × ${gil(v.price)} <span class="w">NPC</span></span>${boardNote}</div>${vendorsHtml(v)}`;
  }
  if (!ing.marketable) return '<span class="mut">not sold on the board</span>';
  const p = ing.plan;
  if (!p.listings) return '<span class="bad">no listings</span>';
  const chips = p.plan.map((l) => `<span class="stack ${l.hq ? 'hq' : ''}" title="${l.retainer ? esc(l.retainer) + ' · ' : ''}${l.quantity} × ${gil(l.pricePerUnit)} = ${gil(l.total)}">${l.quantity} × ${gil(l.pricePerUnit)}${l.hq ? ' HQ' : ''}${l.world ? ` <span class="w">${esc(l.world)}</span>` : ''}</span>`).join('');
  const extra = [];
  if (p.leftover) extra.push(`<span class="mut">+${p.leftover} spare</span>`);
  if (p.short) extra.push(`<span class="bad">only ${p.available} on the board</span>`);
  if (v) extra.push(`<span class="mut" title="An NPC sells it too, but the board is cheaper here">NPC ${gil(v.price)}/ea = ${gil(v.cost)}</span>`);
  return `<div class="plan">${chips}${extra.join('')}</div>${v ? vendorsHtml(v) : ''}`;
}

function pricingHtml(r, price) {
  const it = state.items[r.result] || {};
  const rows = price.ingredients.map((ing) => {
    const it = state.items[ing.id] || {};
    const p = ing.plan;
    const age = ageText(ing.lastUpload);
    const naive = ing.source === 'board' && p?.cheapestUnit != null ? p.cheapestUnit * ing.need : null;
    const costCell = ing.source === 'none' ? '<span class="mut">–</span>' : gil(ing.cost);
    const stackNote = ing.stackSize > 1 ? `<span class="cat">stack ${ing.stackSize}</span>` : '';
    return `<tr class="${ing.excluded ? 'excluded' : ''}">
      <td><span class="iname"><img class="ico sm" loading="lazy" src="/icon/${ing.id}" alt="">
        <span>${it.r?.length ? `<a class="link" href="#r=${it.r[0]}" title="Craftable — open recipe">${esc(it.n)}</a>` : esc(it.n)}<br>${stackNote}</span></span></td>
      <td class="num">${ing.have ? `${ing.need}<br><span class="good" title="In your inventory (any quality counts for crafting)">have ${ing.have}${ing.haveHq ? ` (${ing.haveHq} HQ)` : ''} of ${ing.required}</span>` : `${ing.need}${price.crafts > 1 ? `<br><span class="mut">${ing.amount} × ${price.crafts}</span>` : ''}`}</td>
      <td class="num ${ing.source === 'board' && p?.short ? 'bad' : ''}">${ing.excluded ? `<span class="mut" title="Ignored in the total">(${gil(ing.cost || 0)})</span>` : costCell}
        ${naive != null && p.cost > naive ? `<br><span class="mut" title="Cost if you could buy exactly ${ing.need} at the cheapest unit price">ideal ${gil(naive)}</span>` : ''}</td>
      <td>${planHtml(ing)}</td>
      <td class="num">${ing.marketable && p?.cheapestUnit != null ? gil(p.cheapestUnit) : '<span class="mut">–</span>'}</td>
      <td><span class="age ${age.old ? 'old' : ''}" title="Last time this item's board was uploaded to Universalis">${ing.marketable ? age.text : ''}</span></td>
    </tr>`;
  }).join('');

  const res = price.result;
  const yieldTotal = price.units;
  // Sell price: what it actually sold for this week, falling back to the
  // cheapest current listing when nothing has sold.
  const s = res.sales;
  const wantHq = price.quality === 'hq';
  const bucket = s ? (wantHq ? (s.hq.units ? s.hq : null) : (s.nq.units ? s.nq : s.hq.units ? s.hq : null)) : null;
  const listed = res.marketable ? (wantHq ? res.cheapestHq : (res.cheapestNq ?? res.cheapestHq)) : null;
  const sellAt = bucket ? (listed != null ? Math.min(bucket.median, listed) : bucket.median) : listed;
  const sellBasis = bucket
    ? `${price.quality === 'any' && !s.nq.units && s.hq.units ? 'HQ ' : wantHq ? 'HQ ' : 'NQ '}median of last ${s.days} days${listed != null && listed < bucket.median ? ', capped at the cheapest listing' : ''}`
    : listed != null ? 'cheapest current listing (nothing sold this week)' : null;
  const revenue = sellAt != null ? sellAt * yieldTotal : null;
  const margin = revenue != null ? revenue - price.total : null;
  const perDay = (n) => (n >= 10 ? n.toFixed(0) : n >= 1 ? n.toFixed(1) : n.toFixed(2)).replace(/\.0+$/, '');
  const salesLine = (label, b) => b.units
    ? `${label} median <b>${gil(b.median)}</b> <span class="mut">(avg ${gil(b.avg)})</span> · ${b.sales} sale${b.sales === 1 ? '' : 's'} <span class="mut">(${b.units} units, ${perDay(b.sales / 7)}/day)</span>`
    : `${label} <span class="mut">none sold</span>`;
  const saved = price.greedyTotal - price.total;

  return `
    <div class="totals">
      <div class="card"><div class="k">Materials total</div><div class="n">${gil(price.total)}</div>
        <div class="d">${yieldTotal} unit${yieldTotal > 1 ? 's' : ''} = ${price.crafts} craft${price.crafts > 1 ? 's' : ''}${r.yields > 1 ? ` × ${r.yields}` : ''} · ${esc(price.world)}${price.ignoreCrystals && price.crystalCost ? `<br><span class="warn">crystals ignored (${gil(price.crystalCost)})</span>` : ''}</div></div>
      <div class="card"><div class="k">Per unit made</div><div class="n small">${gil(price.perUnit)}</div>
        <div class="d">${price.perCraft !== price.perUnit ? `${gil(price.perCraft)} per craft` : '&nbsp;'}</div></div>
      <div class="card wide"><div class="k">Market, last ${s ? s.days : 7} days</div>
        ${res.marketable ? (s ? `
        <div class="n small">${s.all.units ? `${s.all.sales} sale${s.all.sales === 1 ? '' : 's'} · ${perDay(s.all.sales / 7)} per day <span class="mut">(${s.all.units} units)</span>` : '<span class="mut">nothing sold this week</span>'}</div>
        <div class="d">${salesLine('NQ', s.nq)}<br>${salesLine('HQ', s.hq)}</div>
        <div class="d">now listed: ${res.cheapestNq != null ? `${gil(res.cheapestNq)} NQ` : ''}${res.cheapestNq != null && res.cheapestHq != null ? ' · ' : ''}${res.cheapestHq != null ? `<span class="hq">${gil(res.cheapestHq)} HQ</span>` : ''}${res.cheapestNq == null && res.cheapestHq == null ? '<span class="mut">no listings</span>' : ` <span class="mut">(${res.listings} listing${res.listings === 1 ? '' : 's'}, ${ageText(res.lastUpload).text})</span>`}</div>`
        : `<div class="n small mut">history unavailable</div><div class="d">now listed: ${res.cheapestNq != null ? gil(res.cheapestNq) + ' NQ' : ''} ${res.cheapestHq != null ? gil(res.cheapestHq) + ' HQ' : ''}</div>`)
        : '<div class="n small mut">not marketable</div>'}</div>
      ${it.g ? `<div class="card"><div class="k">Expert delivery</div>
        <div class="n small seal">${gil(it.g * yieldTotal)} seals</div>
        <div class="d">${yieldTotal > 1 ? `${yieldTotal} × ${gil(it.g)} · ` : ''}${(price.perUnit / it.g).toFixed(1)} gil per seal</div></div>` : ''}
      <div class="card"><div class="k">Margin if sold</div>
        <div class="n small ${margin == null ? 'mut' : margin >= 0 ? 'good' : 'bad'}">${margin == null ? '–' : (margin >= 0 ? '+' : '') + gil(margin)}</div>
        <div class="d">${revenue != null ? `selling ${yieldTotal} at ${gil(sellAt)} (${sellBasis}), before tax` : '&nbsp;'}</div></div>
    </div>
    <div class="sheet tbl">
      <table>
        <thead><tr><th>Material</th><th class="num">Need</th><th class="num">Cost</th><th>Buy these stacks</th><th class="num">Cheapest / unit</th><th>Board data</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><td colspan="2">Total${price.shortfall ? ` <span class="bad">· ${price.shortfall} material${price.shortfall > 1 ? 's' : ''} short on the board</span>` : ''}</td><td class="num">${gil(price.total)}</td><td colspan="3"></td></tr></tfoot>
      </table>
    </div>
    <p class="note">
      Stacks are chosen so the whole set costs the least while still covering what you need, since the board only sells listings whole.
      ${price.ingredients.some((i) => i.source === 'vendor') ? 'Materials marked <span class="npc">NPC</span> are cheaper from a gil vendor, so the total assumes you buy those from the vendor listed.' : ''}
      ${saved > 0 ? `That saves <b class="good">${gil(saved)}</b> against simply buying the cheapest-per-unit stacks until covered.` : ''}
      ${price.ignoreCrystals ? 'Shards, crystals and clusters are shown but left out of the total.' : ''}
      ${price.quality !== 'any' ? `Only ${price.quality.toUpperCase()} listings are considered.` : 'NQ and HQ listings are both considered; switch to NQ or HQ above to restrict.'}
      Prices are whatever Universalis last saw; check the board age column.
    </p>`;
}

async function reprice() {
  const r = state.selected;
  if (!r) return;
  const req = ++state.priceReq;
  const box = $('#pricing');
  if (box) box.innerHTML = '<div class="spinner">Fetching listings from Universalis…</div>';
  setStatus('', `pricing on ${state.world}…`);
  try {
    const url = `/api/price/${r.id}?world=${encodeURIComponent(state.world)}&units=${state.units}&quality=${state.quality}&ignoreCrystals=${state.noCrystals ? 1 : 0}&inventory=${$('#useInv')?.checked ? 1 : 0}`;
    const res = await fetch(url);
    const data = await res.json();
    if (req !== state.priceReq) return;
    if (!res.ok) throw new Error(data.error || res.statusText);
    const el = $('#pricing');
    if (el) el.innerHTML = pricingHtml(r, data);
    setStatus('ok', `priced on ${data.world}`);
  } catch (err) {
    if (req !== state.priceReq) return;
    const el = $('#pricing');
    if (el) el.innerHTML = `<div class="spinner bad">Could not price: ${esc(err.message)}</div>`;
    setStatus('err', 'Universalis unavailable');
  }
}

boot().catch((err) => setStatus('err', err.message));
