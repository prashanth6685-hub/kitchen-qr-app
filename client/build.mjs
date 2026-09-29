// Build script: bundles the ngc (AOT) output with esbuild and assembles client/dist.
// Run: npm run build   (ngc must have run first — the npm script chains them)
import { build } from 'esbuild';
import { cpSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'dist');

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// 1. App bundle (ngc already compiled Angular templates to plain JS)
await build({
  entryPoints: [join(root, '.aot', 'main.js')],
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'es2022',
  outfile: join(dist, 'app.js'),
  logLevel: 'info',
});

// 2. Styles (app CSS + Grid.js theme, resolved from node_modules)
await build({
  entryPoints: [join(root, 'src', 'styles.css')],
  bundle: true,
  minify: true,
  outfile: join(dist, 'styles.css'),
  logLevel: 'info',
});

// 3. Static files
cpSync(join(root, 'src', 'index.html'), join(dist, 'index.html'));
for (const f of ['sw.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png']) {
  cpSync(join(root, 'src', 'pwa', f), join(dist, f));
}

console.log('[build] dist/ ready');
