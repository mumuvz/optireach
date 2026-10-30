import { decryptSecret, randomToken } from '@surfaced/core/crypto';
import { getPrisma } from '@surfaced/core/db';
import { getLogger } from '@surfaced/core/logger';
import { MemoryQueueGateway } from '@surfaced/core/queue';
import type { MeDto } from '@surfaced/shared';
import request from 'supertest';
import { createApp } from '../src/app';

export const API = '/api/v1';

/** Tests register many accounts from one IP, so limits are relaxed unless a test asks for real ones. */
export function createTestApp({ rateLimitMultiplier = 100 }: { rateLimitMultiplier?: number } = {}) {
  const queues = new MemoryQueueGateway();
  const { app } = createApp({
    prisma: getPrisma(),
    queues,
    redis: null,
    logger: getLogger('api-test'),
    rateLimitMultiplier,
  });
  return { app, queues, prisma: getPrisma() };
}

type App = ReturnType<typeof createTestApp>['app'];

/** Cookie-keeping client that sends the CSRF header like the real SPA does. */
export class TestClient {
  readonly agent: ReturnType<typeof request.agent>;
  csrf = '';

  constructor(app: App) {
    this.agent = request.agent(app);
  }

  async init(): Promise<this> {
    const res = await this.agent.get(`${API}/auth/csrf`).expect(200);
    this.csrf = res.body.data.csrfToken;
    return this;
  }

  /** Re-reads the CSRF cookie after login/logout rotate it. */
  private refreshCsrf(res: request.Response): void {
    const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
    const csrfCookie = cookies.find((c) => c.startsWith('sf_csrf='));
    if (csrfCookie) this.csrf = decodeURIComponent(csrfCookie.split(';')[0]!.slice('sf_csrf='.length));
  }

  get(path: string) {
    return this.agent.get(`${API}${path}`);
  }

  async send(method: 'post' | 'patch' | 'put' | 'delete', path: string, body?: object) {
    const res = await this.agent[method](`${API}${path}`)
      .set('X-CSRF-Token', this.csrf)
      .send(body ?? {});
    this.refreshCsrf(res);
    return res;
  }

  post(path: string, body?: object) {
    return this.send('post', path, body);
  }
  patch(path: string, body?: object) {
    return this.send('patch', path, body);
  }
  put(path: string, body?: object) {
    return this.send('put', path, body);
  }
  delete(path: string) {
    return this.send('delete', path);
  }
}

export const DEFAULT_PASSWORD = 'a-strong-test-passphrase';

export function uniqueEmail(prefix = 'user'): string {
  return `${prefix}-${randomToken(6)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, 'x')}@example.test`;
}

export async function registerClient(
  app: App,
  overrides: { name?: string; email?: string; password?: string } = {},
) {
  const client = await new TestClient(app).init();
  const email = overrides.email ?? uniqueEmail();
  const res = await client.post('/auth/register', {
    name: overrides.name ?? 'Test User',
    email,
    password: overrides.password ?? DEFAULT_PASSWORD,
    acceptTerms: true,
  });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  const me = res.body.data as MeDto;
  return { client, email, me, workspaceId: me.currentWorkspaceId! };
}

/** Returns the decrypted text of the most recent queued email sent to `to`. */
export function lastEmailTo(
  queues: MemoryQueueGateway,
  prismaDeliveries: { id: string; toAddress: string }[],
  to: string,
) {
  const ids = new Set(prismaDeliveries.filter((d) => d.toAddress === to).map((d) => d.id));
  const job = [...queues.jobs]
    .reverse()
    .find((j) => j.queue === 'email' && ids.has((j.data as { deliveryId: string }).deliveryId));
  if (!job) throw new Error(`No queued email for ${to}`);
  const message = JSON.parse(decryptSecret((job.data as { encryptedMessage: string }).encryptedMessage)) as {
    subject: string;
    text: string;
  };
  return message;
}

export async function emailTokenFor(
  queues: MemoryQueueGateway,
  to: string,
  template: string,
): Promise<string> {
  const deliveries = await getPrisma().emailDelivery.findMany({
    where: { toAddress: to, template },
    select: { id: true, toAddress: true },
  });
  const message = lastEmailTo(queues, deliveries, to);
  const match = /token=([A-Za-z0-9_%-]+)/.exec(message.text);
  if (!match) throw new Error('No token in email');
  return decodeURIComponent(match[1]!);
}
