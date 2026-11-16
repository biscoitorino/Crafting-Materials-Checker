/**
 * Builds the standalone Windows executable.
 *
 * The app is bundled into one CommonJS file, the UI and lookup tables are
 * embedded as assets, and the result is injected into a copy of the Node
 * runtime as a single-executable application. The output needs no Node
 * install: it is one .exe that writes its data folder next to itself.
 *
 *   npm run build
 *
 * Produces dist/CraftingMaterialsChecker.exe and a zip beside it.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const work = path.join(root, 'build');
const dist = path.join(root, 'dist');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const EXE = 'CraftingMaterialsChecker.exe';

const say = (msg) => console.log(`[build] ${msg}`);
// Captured rather than inherited: an inherited handle hangs when the build is
// run without a console attached to it.
const run = (cmd, args) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 300_000 });
const mb = (file) => `${(fs.statSync(file).size / 1024 / 1024).toFixed(1)} MB`;

if (process.platform !== 'win32') {
  console.error('[build] This build targets Windows and must run on Windows.');
  process.exit(1);
}

fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });
fs.mkdirSync(dist, { recursive: true });

// 1. One self-contained CommonJS file.
say('bundling…');
await build({
  entryPoints: [path.join(root, 'src', 'index.js')],
  outfile: path.join(work, 'app.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  minify: true,
  legalComments: 'none',
  define: {
    'process.env.NODE_ENV': '"production"',
    // The packaged build never takes the branch that uses this; defining it
    // keeps the CommonJS output free of an import.meta warning.
    'import.meta.url': '"file:///packaged"',
  },
  banner: { js: '"use strict";' },
});
say(`bundle ${mb(path.join(work, 'app.cjs'))}`);

// 2. Everything the app reads but never writes travels inside the exe.
const assets = {};
for (const file of fs.readdirSync(path.join(root, 'public'))) {
  if (fs.statSync(path.join(root, 'public', file)).isFile()) assets[`public/${file}`] = `public/${file}`;
}
for (const file of fs.readdirSync(path.join(root, 'public', 'assets'))) {
  assets[`public/assets/${file}`] = `public/assets/${file}`;
}
for (const file of ['gc-seals.json', 'master-books.json']) {
  assets[`assets/${file}`] = `assets/${file}`;
}
const seaConfig = path.join(work, 'sea-config.json');
fs.writeFileSync(seaConfig, JSON.stringify({
  main: path.join(work, 'app.cjs'),
  output: path.join(work, 'sea.blob'),
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: true,
  assets,
}, null, 2));
say(`${Object.keys(assets).length} embedded assets`);

// 3. Blob, then a copy of the Node runtime to inject it into.
say('preparing the executable…');
run(process.execPath, ['--experimental-sea-config', seaConfig]);
const exe = path.join(dist, EXE);
fs.copyFileSync(process.execPath, exe);

// An inherited signature would be invalid once the blob is injected.
try {
  execFileSync('signtool', ['remove', '/s', exe], { stdio: 'ignore', timeout: 30_000 });
} catch { /* signtool is part of the Windows SDK and usually absent; harmless */ }

// 4. Icon and version info first: rcedit parses the executable's resources,
// and it cannot cope with the blob once that has been appended.
try {
  const rcedit = path.join(root, 'node_modules', 'rcedit', 'bin', 'rcedit-x64.exe');
  if (fs.existsSync(rcedit)) {
    run(rcedit, [
      exe,
      '--set-icon', path.join(root, 'assets', 'crafting.ico'),
      '--set-version-string', 'ProductName', 'Crafting Materials Checker',
      '--set-version-string', 'FileDescription', pkg.description,
      '--set-version-string', 'LegalCopyright', 'MIT licensed',
      '--set-file-version', pkg.version,
      '--set-product-version', pkg.version,
    ]);
    say('icon and version info applied');
  } else {
    say('rcedit not installed, leaving the default Node icon');
  }
} catch (err) {
  say(`could not set the icon (${err.message}); continuing`);
}

// 5. The app itself.
run(process.execPath, [
  path.join(root, 'node_modules', 'postject', 'dist', 'cli.js'),
  exe, 'NODE_SEA_BLOB', path.join(work, 'sea.blob'),
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
]);
say(`${EXE} ${mb(exe)}`);

// 6. A zip anyone can download, unpack and run.
const readme = path.join(work, 'README.txt');
fs.writeFileSync(readme, [
  'Crafting Materials Checker',
  '==========================',
  '',
  'Double-click CraftingMaterialsChecker.exe, then open http://127.0.0.1:8790',
  'in your browser. Nothing to install: Node is already inside the executable.',
  '',
  'On the first run it downloads the game data (about 30 MB) and writes it to a',
  '"data" folder next to the executable, along with item icons as it needs them.',
  'Keep the executable somewhere it is allowed to write, such as your Documents',
  'folder rather than Program Files.',
  '',
  'Settings (optional): copy env-example.txt to ".env" next to the executable to',
  'change the port, the item language or the world shown on first load.',
  '',
  'Inventory (optional): export a list from the Allagan Tools Dalamud plugin as',
  'CSV and save it as data\\export.csv.',
  '',
  'Windows SmartScreen may warn about an unsigned program the first time:',
  'choose More info, then Run anyway.',
  '',
  'Source, issues and documentation:',
  'https://github.com/biscoitorino/Crafting-Materials-Checker',
  '',
  'MIT licensed. Not affiliated with or endorsed by Square Enix.',
].join('\r\n'));

const zip = path.join(dist, `CraftingMaterialsChecker-v${pkg.version}-win-x64.zip`);
fs.rmSync(zip, { force: true });
const staging = path.join(work, 'zip');
fs.mkdirSync(staging);
fs.copyFileSync(exe, path.join(staging, EXE));
fs.copyFileSync(readme, path.join(staging, 'README.txt'));
fs.copyFileSync(path.join(root, '.env.example'), path.join(staging, 'env-example.txt'));
fs.copyFileSync(path.join(root, 'LICENSE'), path.join(staging, 'LICENSE.txt'));
run('powershell', [
  '-NoProfile', '-Command',
  `Compress-Archive -Path '${staging}\\*' -DestinationPath '${zip}' -CompressionLevel Optimal`,
]);
say(`${path.basename(zip)} ${mb(zip)}`);

say('done');
