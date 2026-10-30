// Prisma 7 configuration. Prisma no longer loads .env automatically, so load it here.
// Variables that are already set in the environment take precedence over the file.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'prisma/config';

const envFile = path.resolve(process.cwd(), '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    // `prisma generate` does not connect; a placeholder keeps it working without a database.
    url: process.env.DATABASE_URL ?? 'mysql://set-DATABASE_URL@localhost:3306/missing',
  },
});
