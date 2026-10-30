// Optional single-process deployment: when SERVE_WEB_DIST=true the API also serves the built web app
// (apps/web/dist). Prerendered marketing pages are served as static HTML, /app/* gets the SPA shell,
// hashed assets are cached for a year, and unknown paths get the prerendered 404 page with status 404.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { findRepoRoot, getEnv } from '@surfaced/core/env';
import express, { type Express, type Response } from 'express';
import helmet from 'helmet';

/** Paths handled by the client-side app (never prerendered; noindex shell). */
const SPA_PREFIXES = ['/app', '/verify-email', '/invite'];

export function resolveWebDist(): string {
  return path.join(findRepoRoot(), 'apps', 'web', 'dist');
}

/** Maps a request path to the prerendered file, the SPA shell or the 404 page. */
export function resolveWebFile(dist: string, requestPath: string): { file: string; status: number } {
  let decoded: string;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return { file: path.join(dist, '404.html'), status: 404 };
  }
  if (SPA_PREFIXES.some((prefix) => decoded === prefix || decoded.startsWith(`${prefix}/`)))
    return { file: path.join(dist, 'app.html'), status: 200 };
  const clean = path.posix.normalize(decoded).replace(/\/+$/, '') || '/';
  const candidate = path.resolve(
    dist,
    clean === '/' ? 'index.html' : path.join(clean.slice(1), 'index.html'),
  );
  if (candidate.startsWith(dist + path.sep) && existsSync(candidate)) return { file: candidate, status: 200 };
  return { file: path.join(dist, '404.html'), status: 404 };
}

export function mountWebApp(app: Express, dist = resolveWebDist()): void {
  const env = getEnv();
  if (!existsSync(path.join(dist, 'index.html')) || !existsSync(path.join(dist, 'app.html'))) {
    throw new Error(
      `SERVE_WEB_DIST=true but ${dist} does not contain a web build. Run "npm run build" first.`,
    );
  }
  const pageHelmet = helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        // React style attributes and chart libraries set inline styles.
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        frameSrc: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        objectSrc: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    hsts: env.isProduction ? { maxAge: 31_536_000, includeSubDomains: true } : false,
  });
  app.use((req, res, next) => (req.path.startsWith('/api') ? next() : pageHelmet(req, res, next)));
  app.use(
    '/assets',
    express.static(path.join(dist, 'assets'), {
      immutable: true,
      maxAge: '365d',
      index: false,
      fallthrough: false,
    }),
  );
  app.use(express.static(dist, { index: false, redirect: false, maxAge: '1h' }));
  const send = (res: Response, file: string, status: number) => {
    res.status(status).set('Cache-Control', 'no-cache').sendFile(file);
  };
  app.get(/^(?!\/api(\/|$)).*/, (req, res) => {
    const { file, status } = resolveWebFile(dist, req.path);
    send(res, file, status);
  });
}
