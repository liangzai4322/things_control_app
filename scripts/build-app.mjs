import { createHash } from 'node:crypto';
import { access, copyFile, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, transform } from 'esbuild';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(rootDir, 'dist');
const assetsDir = path.join(distDir, 'assets');

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function copyIfPresent(relativePath) {
  const source = path.join(rootDir, relativePath);
  if (!(await exists(source))) return;
  const destination = path.join(distDir, relativePath);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

async function findSingleAsset(pattern, label) {
  const matches = (await readdir(assetsDir)).filter((name) => pattern.test(name));
  if (matches.length !== 1) {
    throw new Error(`Expected one ${label} output, found ${matches.length}.`);
  }
  return matches[0];
}

await rm(distDir, { recursive: true, force: true });
await mkdir(assetsDir, { recursive: true });

await build({
  entryPoints: [path.join(rootDir, 'js', 'app.js')],
  outdir: assetsDir,
  bundle: true,
  splitting: true,
  format: 'esm',
  minify: true,
  sourcemap: false,
  target: ['es2020'],
  entryNames: 'app-[hash]',
  chunkNames: 'chunk-[hash]',
  legalComments: 'none',
  charset: 'utf8',
});

await build({
  entryPoints: [path.join(rootDir, 'css', 'style.css')],
  outdir: assetsDir,
  bundle: true,
  minify: true,
  sourcemap: false,
  target: ['es2020'],
  entryNames: 'style-[hash]',
  legalComments: 'none',
  charset: 'utf8',
});

const appFile = await findSingleAsset(/^app-[A-Z0-9]+\.js$/i, 'JavaScript entry');
const styleFile = await findSingleAsset(/^style-[A-Z0-9]+\.css$/i, 'CSS entry');

let html = await readFile(path.join(rootDir, 'index.html'), 'utf8');
html = html
  .replace(/^\s*<link\s+rel=["']modulepreload["'][^>]*>\s*$/gim, '')
  .replace('href="css/style.css"', `href="assets/${styleFile}"`)
  .replace('src="js/app.js"', `src="assets/${appFile}"`);
await writeFile(path.join(distDir, 'index.html'), html, 'utf8');

await cp(path.join(rootDir, 'assets', 'icons'), path.join(distDir, 'assets', 'icons'), { recursive: true });
await copyIfPresent('manifest.json');
await copyIfPresent('.nojekyll');
await copyIfPresent(path.join('data', 'pavilion.json'));
await copyIfPresent(path.join('data', 'tower.json'));

const outputFiles = [];
async function collectFiles(directory, prefix = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relativePath = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(path.join(directory, entry.name), relativePath);
    } else if (entry.name !== 'service-worker.js') {
      outputFiles.push(`./${relativePath}`);
    }
  }
}
await collectFiles(distDir);
outputFiles.sort();

const buildId = createHash('sha256').update(outputFiles.join('\n')).digest('hex').slice(0, 12);
const serviceWorkerSource = `
const CACHE_NAME = 'taskbox-dist-${buildId}';
const CACHE_FILES = ${JSON.stringify(outputFiles)};

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(CACHE_FILES)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  const refresh = fetch(request).then(async (response) => {
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, response.clone());
    }
    return response;
  });
  event.waitUntil(refresh.then(() => undefined).catch(() => {}));
  event.respondWith(caches.match(request).then((cached) => cached || refresh));
});
`;
const minifiedWorker = await transform(serviceWorkerSource, {
  loader: 'js',
  minify: true,
  target: 'es2020',
  legalComments: 'none',
});
await writeFile(path.join(distDir, 'service-worker.js'), minifiedWorker.code, 'utf8');

const sourceBytes = (await Promise.all([
  readFile(path.join(rootDir, 'index.html')),
  readFile(path.join(rootDir, 'css', 'style.css')),
  ...((await readdir(path.join(rootDir, 'js')))
    .filter((name) => name.endsWith('.js'))
    .map((name) => readFile(path.join(rootDir, 'js', name)))),
])).reduce((sum, file) => sum + file.length, 0);

const distBytes = (await Promise.all(outputFiles.map(async (relativePath) => {
  const filePath = path.join(distDir, relativePath.replace(/^\.\//, '').replaceAll('/', path.sep));
  return (await readFile(filePath)).length;
}))).reduce((sum, size) => sum + size, 0);

console.log(JSON.stringify({
  buildId,
  app: `assets/${appFile}`,
  style: `assets/${styleFile}`,
  files: outputFiles.length + 1,
  sourceBytes,
  distBytes,
  sourceMap: false,
}, null, 2));
