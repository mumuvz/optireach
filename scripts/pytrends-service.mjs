// Optional experimental Google Trends provider (pytrends). Usage:
//   node scripts/pytrends-service.mjs setup   creates services/pytrends/.venv and installs requirements
//   node scripts/pytrends-service.mjs start   runs the service (reads PYTRENDS_* settings from .env)
//   node scripts/pytrends-service.mjs test    runs its unit tests (a fake pytrends client; nothing reaches Google)
// pytrends is unofficial and archived; see docs/providers/keyword-trends.md.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const dir = path.join(root, 'services', 'pytrends');
const venv = path.join(dir, '.venv');
const python = path.join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const envFile = path.join(root, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const command = process.argv[2];
if (command === 'setup') {
  const system = process.platform === 'win32' ? 'python' : 'python3';
  if (!existsSync(python)) {
    const created = spawnSync(system, ['-m', 'venv', venv], { stdio: 'inherit' });
    if (created.status !== 0) process.exit(created.status ?? 1);
  }
  const installed = spawnSync(python, ['-m', 'pip', 'install', '-r', path.join(dir, 'requirements.txt')], {
    stdio: 'inherit',
  });
  process.exit(installed.status ?? 1);
} else if (command === 'start') {
  if (!existsSync(python)) {
    console.error('Run `npm run trends:setup` first.');
    process.exit(1);
  }
  const url = new URL(process.env.PYTRENDS_SERVICE_URL || 'http://127.0.0.1:4410');
  // The service gets its own settings and what the OS and Python need, never the app's other secrets.
  const SYSTEM =
    /^(PATH|PATHEXT|SYSTEMROOT|SYSTEMDRIVE|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|LANG|LC_ALL|TZ|SSL_CERT_FILE|REQUESTS_CA_BUNDLE|HTTPS?_PROXY|NO_PROXY)$/i;
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.startsWith('PYTRENDS_') || SYSTEM.test(key)),
  );
  const child = spawn(python, ['-I', path.join(dir, 'app.py')], {
    stdio: 'inherit',
    env: { ...env, PYTRENDS_HOST: url.hostname, PYTRENDS_PORT: url.port || '4410' },
  });
  child.on('exit', (code) => process.exit(code ?? 0));
} else if (command === 'test') {
  if (!existsSync(python)) {
    console.error('Run `npm run trends:setup` first.');
    process.exit(1);
  }
  const tested = spawnSync(python, ['-m', 'unittest', 'discover', '-s', dir], { stdio: 'inherit' });
  process.exit(tested.status ?? 1);
} else {
  console.error('Usage: node scripts/pytrends-service.mjs setup|start|test');
  process.exit(1);
}
