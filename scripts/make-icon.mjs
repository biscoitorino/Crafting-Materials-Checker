/**
 * Builds the Windows application icons from public/assets/crafting.svg.
 *
 * Produces assets/crafting.ico, holding several sizes so Windows can pick the
 * right one, and the PNG the web UI uses.
 *
 * Run with: npm run icon
 * Only needed after editing the SVG. The .ico is committed, so a normal
 * install does not need the rasteriser at all.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const svg = fs.readFileSync(path.join(root, 'public', 'assets', 'crafting.svg'));
const outDir = path.join(root, 'assets');
fs.mkdirSync(outDir, { recursive: true });

const SIZES = [16, 24, 32, 48, 64, 128, 256];

const render = (size) =>
  new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();

/**
 * Packs PNGs into an .ico. Windows Vista onward reads PNG-compressed entries
 * directly, so the images go in as-is with no BMP conversion.
 */
function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);              // reserved
  header.writeUInt16LE(1, 2);              // type 1 = icon
  header.writeUInt16LE(images.length, 4);  // image count

  const entries = [];
  let offset = 6 + images.length * 16;

  for (const { size, data } of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);  // 0 means 256
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);                       // palette colours
    entry.writeUInt8(0, 3);                       // reserved
    entry.writeUInt16LE(1, 4);                    // colour planes
    entry.writeUInt16LE(32, 6);                   // bits per pixel
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += data.length;
  }

  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

const live = SIZES.map((size) => ({ size, data: render(size) }));

const write = (name, images) => {
  const file = path.join(outDir, name);
  fs.writeFileSync(file, buildIco(images));
  console.log(`${name}: ${images.length} sizes, ${fs.statSync(file).size} bytes`);
};

write('crafting.ico', live);

// A plain PNG too, handy for the dashboard and anywhere an .ico will not do.
fs.writeFileSync(path.join(root, 'public', 'assets', 'crafting.png'), render(256));
console.log('public/assets/crafting.png: 256x256');
