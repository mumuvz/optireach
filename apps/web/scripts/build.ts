// Production build: client bundle, SSR bundle for prerendering, then the prerender step.
// NODE_ENV is set here because the shared root .env sets NODE_ENV=development for the API, and Vite
// would otherwise honour it and ship React's development build.
import path from 'node:path';

process.env.NODE_ENV = 'production';

const root = path.resolve(import.meta.dirname, '..');
const { build } = await import('vite');

await build({ root, mode: 'production', logLevel: 'warn' });
await build({
  root,
  mode: 'production',
  logLevel: 'warn',
  build: { ssr: 'src/entry-server.tsx', outDir: 'dist-ssr', emptyOutDir: true },
});
await import('./prerender');
