# Crafting Materials Checker

A local web UI for FFXIV crafters. Browse every recipe by class, see the recipe sheet
(durability, difficulty, max quality, yield, craftsmanship recommendation, ingredients), and
price the materials on the market board through [Universalis](https://universalis.app).

## What makes the pricing different

The market board sells listings whole. You cannot take 10 Iron Ingots out of someone's stack
of 99. So "cheapest per unit" is the wrong question: if you need 10, a stack of 10 at 400 each
(4,000) beats a stack of 99 at 200 each (19,800).

For every material the app solves that exactly: it picks the set of listings whose quantities
cover what you need at the lowest total cost, and shows you which stacks to buy, how many spare
units you end up with, and how much it saved against buying cheapest-per-unit stacks blindly.

If an NPC sells the material for gil, the app knows: the ingredient carries an **NPC** badge, and
when the vendor works out cheaper than the board's whole-stack plan (it usually does for base
materials like Rubber or Twinthread) the total assumes you buy from the vendor, and the row shows
the vendor's name, zone and map coordinates. When the board is cheaper, the vendor price is still
shown next to the stacks for comparison.

Equipment recipes also show the **Grand Company expert delivery** seal value (by item level,
from the game's `GCSupplyDutyReward` table via XIVAPI) and a **gil per seal** figure, so seal
farming crafts can be compared directly.

Also shown per material: the cheapest unit price on the board, the item's stack size, how old
the Universalis data is (amber when stale), and a link to the material's own recipe when it is
craftable. The result item's current board price gives a rough margin.

## Profit finder

The **Profit finder** tab ranks everything you can make by what it earns. Enter your level in
each crafting class and tick the master books you own (both are remembered), set a minimum
number of units the item must have sold in the last week, choose NQ or HQ, and scan.

For each recipe: the sale price (the weekly average, capped at the current cheapest listing,
since that is what you would have to undercut), units sold per week, material cost per unit
(cheapest listing or NPC price per material), profit after the 5% market tax, margin, and a
weekly potential (profit × units the whole market sells per week). Click a row to open the
recipe with the exact stack-by-stack cost.

The scan is deliberately gentle on Universalis: it uses the aggregated endpoint (100 items per
request), prices materials only for recipes that actually sell, runs three requests at a time
with a pause between them, caches everything for ten minutes per market, and only ever runs one
scan at once. A full scan of ~2,000 recipes is around 30 requests.

## Flipping

The **Flipping** tab takes a gil budget and finds listings that sit well under what the item
really sells for. One aggregated pass over every item the app knows (100 items a request), then
the best 60 candidates are checked against live listings and the week's sale history. For each
item it buys the cheapest listings whole and relists at the week's median sale, but never above
the cheapest listing it leaves behind, since that becomes the competition: if the board shows
2,000 / 2,005 / 50,000 and the median is 40,000, both cheap ones are bought and relisted at
40,000. Nothing plans more units than the market sold in the last week, anything under an 8%
return is ignored, and the budget goes to the best return first (partial buys when it does not
stretch). Board data age is shown per row: a cheap listing from hours ago may be gone already.

## Your inventory

Export your inventory from the [Allagan Tools](https://github.com/Critical-Impact/InventoryTools)
Dalamud plugin (open a list, **Export to CSV**) and save it as `data/export.csv` (or point
`INVENTORY_CSV` in `.env` at it). Tick **use my inventory** in the Profit finder and:

- the recipe page deducts what you own from every material ("have 28 of 2 · already in your bags")
  and only prices the shortfall;
- **Craft to sell** costs only what you lack;
- **Craft from what I own** lists recipes whose every material is already in your bags, how many
  you can craft, what the materials would fetch sold raw, and what crafting adds on top;
- **Sell what I own as-is** values every marketable stack at a realistic sale price and ranks it.

Items already listed on the market, equipped, or in the armoury chest are not counted. The file
is re-read whenever it changes, so just re-export and hit reload.

## Controls

- **Market** – any world, or a whole data centre (listings then show which world they are on).
- **Crafts** – how many times you will craft; material quantities scale with it.
- **Any / NQ / HQ** – which listings to consider for materials. HQ also switches the margin
  estimate to the result's HQ price.
- Left panel – search, class chips, level range, expert-only.
- Ingredients in blue are craftable; click to jump to their recipe. `#r=<recipeId>` in the URL
  is shareable.

## Data sources

| What | Source |
| --- | --- |
| Recipes, item names, categories, stack sizes, rarity, gil vendors and NPC locations | [FFXIV Teamcraft data set](https://github.com/ffxiv-teamcraft/ffxiv-teamcraft/tree/staging/libs/data/src/lib/json) (kept current with each patch) |
| Item icons, GC expert delivery seal table, master book requirements | [XIVAPI v2](https://v2.xivapi.com), downloaded once each into `data/icons` |
| Listings, worlds, marketable items | [Universalis](https://universalis.app) |

On first start the app downloads the Teamcraft files (~30 MB) and condenses them into
`data/index.json` (recipes for the eight crafting classes plus the items they use). The index
remembers which Teamcraft commit it came from; **check data updates** in the header asks GitHub
for the latest commit to the data folder (one small request) and only downloads and rebuilds
when it differs, swapping the new data in without a restart. `npm run data` forces a rebuild.

## Setup

Node.js 22 or newer.

```bash
npm install
cp .env.example .env
npm start
```

Then open http://127.0.0.1:8790. `.env` holds the port, the item language (`en`, `de`, `fr`,
`ja`) and the world shown on first load.

## Layout

```
src/
  index.js       entry; --rebuild regenerates the data index
  server.js      Fastify: /api/meta, /api/recipes, /api/price/:id, /api/scan, /icon/:id
  scan.js        profit finder (aggregated Universalis stats, throttled and cached)
  recipe-price.js exact per-recipe pricing shared by the page and the finder
  inventory.js   Allagan Tools CSV import
  data.js        builds and loads data/index.json from Teamcraft
  pricing.js     stack-aware purchase planner (exact knapsack over listings)
  universalis.js Universalis client
  icons.js       on-disk icon cache
public/          static UI (no build step)
```

## Desktop shortcut and tray icon (Windows)

```bash
npm run shortcuts
```

puts a **Crafting Materials Checker** shortcut on the desktop. Launching it starts the server in
the background (no console window) and adds a hammer icon to the notification area: full colour
while the server is running, grey when it is stopped. Double-click the icon to open the app in
your browser; right-click for **Open in browser / Stop / Restart / Show logs / Quit**.

`npm run stop` stops the server from a terminal. `npm run icon` rebuilds the `.ico` files from
`public/assets/crafting.svg` if you change the artwork.
