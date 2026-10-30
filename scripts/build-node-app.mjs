// Bundles a Node app (API or worker) into a single ESM file with esbuild.
// Internal workspace packages (@surfaced/*, TypeScript source) are bundled; every third-party
// dependency stays external and is resolved from node_modules at runtime.
// Usage (from an app directory): node ../../scripts/build-node-app.mjs src/index.ts dist/index.js
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const [entry, outfile] = process.argv.slice(2);
if (!entry || !outfile) {
  console.error('Usage: build-node-app.mjs <entry> <outfile>');
  process.exit(1);
}

const root = path.resolve(import.meta.dirname, '..');
const manifests = [
  'package.json',
  'packages/shared/package.json',
  'packages/core/package.json',
  path.relative(root, path.resolve('package.json')),
];

const external = new Set();
for (const manifest of manifests) {
  const pkg = JSON.parse(readFileSync(path.join(root, manifest), 'utf8'));
  for (const name of Object.keys({
    ...pkg.dependencies,
    ...pkg.optionalDependencies,
    ...pkg.peerDependencies,
  })) {
    if (!name.startsWith('@surfaced/')) {
      external.add(name);
      external.add(`${name}/*`);
    }
  }
}
// Optional native/peer modules some dependencies try to load dynamically.
for (const name of ['pino-pretty', 'bufferutil', 'utf-8-validate', 'pg', 'redis', 'bullmq-otel'])
  external.add(name);

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  legalComments: 'none',
  external: [...external],
  banner: {
    // Allow bundled CommonJS-style code to use require() inside the ESM output.
    js: "import { createRequire as __surfacedCreateRequire } from 'node:module'; const require = __surfacedCreateRequire(import.meta.url);",
  },
  logLevel: 'info',
});
