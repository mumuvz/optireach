// Starts a local Redis for development when no Redis is listening on REDIS_URL.
// Looks for a portable Windows build in .tools/redis (see docs/setup.md) or redis-server on PATH.
// It never installs anything; on other platforms prefer `docker compose up -d redis` or a system package.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const port = 6379;

function isListening() {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      socket.end();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
    socket.setTimeout(1000, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function findPortableBinary() {
  const base = path.join(root, '.tools', 'redis');
  if (!existsSync(base)) return null;
  for (const dir of readdirSync(base)) {
    const candidate = path.join(
      base,
      dir,
      process.platform === 'win32' ? 'redis-server.exe' : 'redis-server',
    );
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

if (await isListening()) {
  console.log(`Redis is already listening on 127.0.0.1:${port}.`);
  process.exit(0);
}

let binary = findPortableBinary();
if (!binary) {
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['redis-server'], {
    encoding: 'utf8',
  });
  binary = probe.status === 0 ? probe.stdout.split(/\r?\n/)[0].trim() : null;
}
if (!binary) {
  console.error(
    'No redis-server found. Use `docker compose up -d redis`, install Redis, or see docs/setup.md.',
  );
  process.exit(1);
}

const dataDir = path.join(root, '.tools', 'redis-data');
mkdirSync(dataDir, { recursive: true });
const child = spawn(
  binary,
  [
    '--bind',
    '127.0.0.1',
    '--port',
    String(port),
    '--dir',
    dataDir.replaceAll('\\', '/'),
    '--appendonly',
    'no',
    '--save',
    '',
    '--maxmemory-policy',
    'noeviction',
  ],
  { detached: true, stdio: 'ignore' },
);
child.unref();

for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 250));
  if (await isListening()) {
    console.log(`Started Redis (${binary}) on 127.0.0.1:${port}.`);
    process.exit(0);
  }
}
console.error('Redis did not start within 5 seconds.');
process.exit(1);
