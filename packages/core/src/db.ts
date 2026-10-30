// Prisma 7 client using the MariaDB driver adapter (compatible with MySQL 8).
// DATABASE_URL is the single source of truth for both the Prisma CLI and this runtime client.
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { getEnv } from './env';
import { PrismaClient } from './generated/prisma/client';

export * from './generated/prisma/client';

export interface MysqlConnectionParts {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

/** Parses mysql://user:pass@host:port/db (percent-encoded credentials are decoded). */
export function parseMysqlUrl(url: string): MysqlConnectionParts {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('DATABASE_URL is not a valid URL');
  }
  if (parsed.protocol !== 'mysql:') throw new Error('DATABASE_URL must use the mysql:// scheme');
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!database) throw new Error('DATABASE_URL must include a database name');
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 3306,
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database,
  };
}

export function createPrismaClient(databaseUrl?: string): PrismaClient {
  const env = getEnv();
  const parts = parseMysqlUrl(databaseUrl ?? env.DATABASE_URL);
  const adapter = new PrismaMariaDb({
    host: parts.host,
    port: parts.port,
    user: parts.user,
    password: parts.password,
    database: parts.database,
    connectionLimit: env.DATABASE_CONNECTION_LIMIT,
    // MySQL 8's caching_sha2_password needs the server RSA key on non-TLS connections.
    // Only enable this for local development; production should use TLS (DATABASE_SSL=true).
    allowPublicKeyRetrieval: env.DATABASE_ALLOW_PUBLIC_KEY_RETRIEVAL,
    ssl: env.DATABASE_SSL ? { rejectUnauthorized: true } : undefined,
    connectTimeout: 10_000,
  });
  return new PrismaClient({ adapter });
}

let client: PrismaClient | null = null;

/** Process-wide Prisma client (lazy, so importing this module never opens a connection). */
export function getPrisma(): PrismaClient {
  client ??= createPrismaClient();
  return client;
}

export async function disconnectPrisma(): Promise<void> {
  if (client) {
    const current = client;
    client = null;
    await current.$disconnect();
  }
}

/** Lightweight health probe used by /health and the admin system page. */
export async function pingDatabase(): Promise<boolean> {
  try {
    await getPrisma().$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}
