import fs from 'node:fs';
import Fastify from 'fastify';
import fastifyCompress from '@fastify/compress';
import { config } from './config.js';
import { loadIndex, buildIndex, fetchDataVersion } from './data.js';
import { getIcon } from './icons.js';
import { registerStatic } from './static.js';
import { worldsAndDcs } from './universalis.js';
import { priceRecipe } from './recipe-price.js';
import { loadInventory, inventoryPath } from './inventory.js';
import { startFlip, getFlip } from './flip.js';
import { startScan, getScan } from './scan.js';

const TRANSPARENT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

export async function startServer() {
  // `index` is swapped in place when the data set is updated, so every route
  // reads it through this binding rather than capturing it.
  let index = await loadIndex();
  const updateJob = { status: 'idle', startedAt: 0, error: null, log: [] };
  const app = Fastify({ logger: false });

  await app.register(fastifyCompress, { threshold: 4096 });

  app.get('/api/meta', async () => ({
    builtAt: index.builtAt, lang: index.lang, jobs: index.jobs, books: index.books,
    defaultWorld: config.defaultWorld, recipes: index.recipes.length,
    worlds: await worldsAndDcs().catch(() => []),
  }));

  // The whole recipe table, compact. A few MB gzipped is a one-off per
  // session and lets filtering and search run instantly in the browser.
  app.get('/api/recipes', async (req, reply) => {
    reply.header('Cache-Control', 'public, max-age=3600');
    return { recipes: index.recipes, items: index.items };
  });

  app.get('/api/recipe/:id', async (req, reply) => {
    const r = index.recipes.find((x) => x.id === Number(req.params.id));
    if (!r) return reply.code(404).send({ error: 'unknown recipe' });
    return r;
  });

  /**
   * Prices every ingredient of a recipe on a world or data centre.
   * ?crafts=N multiplies quantities; ?quality=any|nq|hq restricts listings.
   */
  app.get('/api/price/:id', async (req, reply) => {
    const r = index.recipes.find((x) => x.id === Number(req.params.id));
    if (!r) return reply.code(404).send({ error: 'unknown recipe' });
    const world = String(req.query.world || config.defaultWorld);
    // Either a number of crafts, or a number of finished units, which is
    // turned into the crafts needed given the recipe's yield.
    const yields = r.yields || 1;
    const units = Number.parseInt(req.query.units, 10);
    const crafts = Number.isFinite(units) && units > 0
      ? Math.max(1, Math.min(999, Math.ceil(units / yields)))
      : Math.max(1, Math.min(999, Number.parseInt(req.query.crafts, 10) || 1));
    const ignoreCrystals = /^(1|true|yes)$/i.test(String(req.query.ignoreCrystals || ''));
    const quality = ['any', 'nq', 'hq'].includes(req.query.quality) ? req.query.quality : 'any';
    const useInventory = /^(1|true|yes)$/i.test(String(req.query.inventory || ''));
    const inventory = useInventory ? loadInventory(index)?.byId || null : null;
    try {
      return await priceRecipe(index, r, { world, crafts, quality, ignoreCrystals, inventory });
    } catch (err) {
      return reply.code(502).send({ error: `Universalis: ${err.message}` });
    }
  });

  // Inventory from the Allagan Tools export. Re-read whenever the file changes.
  app.get('/api/inventory', async () => {
    const inv = loadInventory(index);
    if (!inv) return { present: false, file: inventoryPath() };
    return { present: true, file: inv.file, updatedAt: inv.mtimeMs, ...inv.summary };
  });

  // Profit finder: starts a scan in the background and is polled for progress.
  app.post('/api/scan', async (req) => {
    const b = req.body || {};
    return startScan(index, {
      market: String(b.market || config.defaultWorld),
      levels: b.levels || {},
      books: Array.isArray(b.books) ? b.books : [],
      expert: !!b.expert,
      minSoldWeek: Number(b.minSoldWeek) || 0,
      sellAs: b.sellAs === 'hq' ? 'hq' : 'nq',
      ignoreCrystals: !!b.ignoreCrystals,
      sortBy: b.sortBy,
      mode: ['buy', 'own', 'sell'].includes(b.mode) ? b.mode : 'buy',
      units: Number(b.units) || 1,
      inventory: b.useInventory ? loadInventory(index)?.byId || null : null,
    });
  });
  app.get('/api/scan/:id', async (req, reply) => {
    const job = getScan(req.params.id);
    if (!job) return reply.code(404).send({ error: 'unknown scan' });
    const { status, done, total, phase, candidates, error, summary } = job;
    return { status, done, total, phase, candidates, error, summary, results: status === 'done' ? job.results : null };
  });

  // Flipping: same background-job shape as the profit finder.
  app.post('/api/flip', async (req) => {
    const b = req.body || {};
    return startFlip(index, {
      market: String(b.market || config.defaultWorld),
      budget: Number(b.budget) || 100_000,
      minSoldWeek: Number(b.minSoldWeek) || 5,
      scope: ['all', 'crafted', 'materials'].includes(b.scope) ? b.scope : 'all',
      ignoreCrystals: !!b.ignoreCrystals,
    });
  });
  app.get('/api/flip/:id', async (req, reply) => {
    const job = getFlip(req.params.id);
    if (!job) return reply.code(404).send({ error: 'unknown scan' });
    const { status, done, total, phase, candidates, error, summary } = job;
    return { status, done, total, phase, candidates, error, summary, results: status === 'done' ? job.results : null };
  });

  // Data set updates. The index remembers which Teamcraft commit it came
  // from; when GitHub reports the same commit there is nothing to download.
  app.get('/api/data/check', async (req, reply) => {
    try {
      const latest = await fetchDataVersion();
      const current = index.source?.sha || null;
      return { current: index.source, latest, upToDate: current === latest.sha, builtAt: index.builtAt, recipes: index.recipes.length, updating: updateJob.status === 'running' };
    } catch (err) {
      return reply.code(502).send({ error: `Could not check GitHub: ${err.message}` });
    }
  });
  app.post('/api/data/update', async (req) => {
    if (updateJob.status === 'running') return { started: false, reason: 'already running' };
    const force = !!req.body?.force;
    let latest = null;
    try { latest = await fetchDataVersion(); } catch { /* still allow a forced rebuild */ }
    if (!force && latest && index.source?.sha === latest.sha) return { started: false, reason: 'up to date', latest };
    updateJob.status = 'running';
    updateJob.startedAt = Date.now();
    updateJob.error = null;
    updateJob.log = [];
    buildIndex({ log: (m) => { updateJob.log.push(m); console.log(m); }, version: latest })
      .then((next) => { index = next; updateJob.status = 'done'; })
      .catch((err) => { updateJob.status = 'error'; updateJob.error = err.message; });
    return { started: true, latest };
  });
  app.get('/api/data/status', async () => ({
    status: updateJob.status, error: updateJob.error, log: updateJob.log.slice(-5),
    builtAt: index.builtAt, source: index.source, recipes: index.recipes.length,
  }));

  app.get('/icon/:id', async (req, reply) => {
    const file = await getIcon(req.params.id);
    reply.header('Cache-Control', 'public, max-age=604800').type('image/png');
    if (!file) return reply.send(TRANSPARENT_PNG);
    try {
      return reply.send(fs.readFileSync(file));
    } catch {
      return reply.send(TRANSPARENT_PNG);
    }
  });

  // The UI itself. Registered last so it only sees what the API did not claim.
  registerStatic(app);

  await app.listen({ port: config.port, host: config.host });
  console.log(`[web] http://${config.host}:${config.port}`);
  return app;
}
