// Vitest globalSetup (runs once per test run, in the main process): brings the isolated test
// database up to date with `prisma migrate deploy`. This is non-destructive — it creates the
// database if missing and applies pending migrations, but never drops data. Tests therefore use
// unique identifiers instead of relying on an empty database. To wipe the test database, run
// `npx prisma migrate reset` yourself with DATABASE_URL pointing at the test database.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

export default function setup(): void {
  const root = path.resolve(import.meta.dirname, '..');
  const envFile = path.join(root, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);

  const testUrl = process.env.TEST_DATABASE_URL;
  if (!testUrl) throw new Error('TEST_DATABASE_URL is not set (see .env.example).');
  const dbName = new URL(testUrl).pathname.replace(/^\//, '');
  if (!dbName.endsWith('_test')) {
    throw new Error(`Refusing to use "${dbName}" for tests: the test database name must end with "_test".`);
  }
  if (process.env.DATABASE_URL && process.env.DATABASE_URL === testUrl) {
    throw new Error('TEST_DATABASE_URL must differ from DATABASE_URL.');
  }
  if (process.env.SKIP_DB_MIGRATE === 'true') return;

  const prismaBin = path.join(root, 'node_modules', 'prisma', 'build', 'index.js');
  try {
    execFileSync(process.execPath, [prismaBin, 'migrate', 'deploy'], {
      cwd: root,
      env: { ...process.env, DATABASE_URL: testUrl },
      stdio: 'pipe',
    });
  } catch (error) {
    const output = error as { stdout?: Buffer; stderr?: Buffer };
    const details = `${output.stdout?.toString() ?? ''}${output.stderr?.toString() ?? ''}`.trim();
    throw new Error(`Could not migrate the test database:\n${details}`, { cause: error });
  }
}
