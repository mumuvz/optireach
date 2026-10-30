import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { mountWebApp } from '../src/web-static';

const dist = mkdtempSync(path.join(tmpdir(), 'surfaced-web-'));
writeFileSync(path.join(dist, 'index.html'), '<html>home</html>');
writeFileSync(path.join(dist, 'app.html'), '<html>spa shell</html>');
writeFileSync(path.join(dist, '404.html'), '<html>not found</html>');
writeFileSync(path.join(dist, 'robots.txt'), 'User-agent: *');
mkdirSync(path.join(dist, 'pricing'));
writeFileSync(path.join(dist, 'pricing', 'index.html'), '<html>pricing</html>');
mkdirSync(path.join(dist, 'assets'));
writeFileSync(path.join(dist, 'assets', 'index-abc123.js'), 'console.log(1)');
writeFileSync(path.join(path.dirname(dist), 'outside-secret.txt'), 'secret');

const app = express();
mountWebApp(app, dist);

afterAll(() => {
  rmSync(dist, { recursive: true, force: true });
  rmSync(path.join(path.dirname(dist), 'outside-secret.txt'), { force: true });
});

describe('web app static serving (SERVE_WEB_DIST)', () => {
  it('serves prerendered pages with a restrictive CSP and no caching of HTML', async () => {
    const home = await request(app).get('/');
    expect(home.status).toBe(200);
    expect(home.text).toContain('home');
    expect(home.headers['content-security-policy']).toContain("script-src 'self'");
    expect(home.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(home.headers['cache-control']).toBe('no-cache');
    expect((await request(app).get('/pricing')).text).toContain('pricing');
    expect((await request(app).get('/pricing/')).text).toContain('pricing');
  });

  it('serves the SPA shell for app routes and a real 404 for unknown paths', async () => {
    const shell = await request(app).get('/app/p/abc/audits');
    expect(shell.status).toBe(200);
    expect(shell.text).toContain('spa shell');
    expect((await request(app).get('/verify-email?token=x')).text).toContain('spa shell');
    const missing = await request(app).get('/no-such-page');
    expect(missing.status).toBe(404);
    expect(missing.text).toContain('not found');
  });

  it('caches hashed assets for a year and does not escape the dist directory', async () => {
    const asset = await request(app).get('/assets/index-abc123.js');
    expect(asset.status).toBe(200);
    expect(asset.headers['cache-control']).toContain('immutable');
    expect((await request(app).get('/assets/missing.js')).status).toBe(404);
    const traversal = await request(app).get('/%2e%2e/outside-secret.txt');
    expect(traversal.status).toBe(404);
    expect(traversal.text).not.toContain('secret');
    expect((await request(app).get('/robots.txt')).text).toContain('User-agent');
  });

  it('leaves /api paths to the API', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('not found</html>');
  });
});
