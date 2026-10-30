# Surfaced

Surfaced is a self-service SaaS for **SEO** (technical audits), **AEO** (answer-ready content) and **GEO**
(visibility in AI-generated answers). It crawls websites safely, scores them with deterministic rules, tracks
how AI assistants mention and cite a brand through official provider APIs, drafts content with an approval
workflow, and reports progress from stored data.

Every metric is calculated from stored records. Demo data, AI estimates and development adapters are labeled as
such, and nothing is published to a customer's website automatically.

## Repository layout

| Path              | What it is                                                                                           |
| ----------------- | ---------------------------------------------------------------------------------------------------- |
| `apps/web`        | React 19 + Vite 8 web app: prerendered marketing site and the dashboard SPA                          |
| `apps/api`        | Express 5 REST API (OpenAPI at `/api/v1/openapi.json`, Swagger UI at `/api/docs`)                    |
| `apps/worker`     | BullMQ workers: crawl, audit, AI visibility, content, competitors, reports, sync, email, maintenance |
| `packages/shared` | Isomorphic zod schemas, enums, plans, permissions, metrics and the audit rule catalog                |
| `packages/core`   | Server-side domain logic shared by the API and worker (database, crawler, providers, billing…)       |
| `prisma`          | Prisma schema, migrations and the development seed                                                   |
| `e2e`             | Playwright end-to-end tests                                                                          |
| `docs`            | Architecture, database, setup, deployment, security, API and other documentation                     |

## Quick start (development)

Prerequisites: Node.js 22.22 or later, MySQL 8, Redis 6.2 or later. See [docs/setup.md](docs/setup.md) for details.

```bash
cp .env.example .env          # then fill in the database URLs and generate the secrets
npm install
npm run db:migrate            # applies migrations to DATABASE_URL
npm run db:seed               # plans, admin and demo accounts, labeled demo workspace
npm run dev                   # API :4000, worker, web :5173
```

Open <http://localhost:5173>. Sign in as `demo@surfaced.test` (or `admin@surfaced.test`) with the password you set
in `SEED_DEMO_PASSWORD`.

## Scripts

| Command                      | What it does                                                                      |
| ---------------------------- | --------------------------------------------------------------------------------- |
| `npm run dev`                | Generates the Prisma client and runs the API, worker and web dev servers together |
| `npm run build`              | Builds the API and worker (esbuild) and the web app (client, SSR, prerender)      |
| `npm run start`              | Runs the built API and worker                                                     |
| `npm run lint`               | ESLint for the whole repository                                                   |
| `npm run typecheck`          | TypeScript checks for every workspace                                             |
| `npm run test`               | Vitest: shared, core, API (Supertest + MySQL) and web (React Testing Library)     |
| `npm run test:e2e`           | Builds the web app and runs the Playwright suite against an isolated stack        |
| `npm run db:migrate`         | `prisma migrate dev` (development)                                                |
| `npm run db:deploy`          | `prisma migrate deploy` (production and CI)                                       |
| `npm run db:seed`            | Development seed; in production it only ensures the default plans                 |
| `npm run db:seed:reset-demo` | Rebuilds the demo workspace (refuses if it contains non-demo projects)            |

## Documentation

- [Setup](docs/setup.md) · [Deployment](docs/deployment.md) · [Security](docs/security.md) · [API](docs/api.md)
- [Architecture](docs/architecture.md) · [Database](docs/database.md) · [Decisions](docs/decisions.md)
- [Audit scoring](docs/scoring.md) · [AI visibility metrics](docs/metrics.md) · [Integrations and providers](docs/integrations.md)
- [Known limitations and credentials checklist](docs/known-limitations.md) · [Test report](docs/test-report.md)
- [Implementation plan](docs/implementation-plan.md) · [Progress log](docs/progress.md) · [Reference site notes](docs/reference/README.md)
