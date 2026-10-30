import { disconnectPrisma } from '@surfaced/core/db';
import { afterAll, describe, expect, it } from 'vitest';
import {
  API,
  DEFAULT_PASSWORD,
  TestClient,
  createTestApp,
  emailTokenFor,
  registerClient,
  uniqueEmail,
} from './helpers';

const { app, queues, prisma } = createTestApp();

afterAll(async () => {
  await disconnectPrisma();
});

describe('registration', () => {
  it('creates the user, an owned workspace on the Free plan, a session and a verification email', async () => {
    const client = await new TestClient(app).init();
    const email = uniqueEmail('reg');
    const res = await client.post('/auth/register', {
      name: 'Ada Lovelace',
      email,
      password: DEFAULT_PASSWORD,
      acceptTerms: true,
    });
    expect(res.status).toBe(201);
    expect(res.body.data.user).toMatchObject({ email, name: 'Ada Lovelace', emailVerified: false });
    expect(res.body.data.memberships).toHaveLength(1);
    expect(res.body.data.memberships[0].role).toBe('OWNER');

    const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
    const session = cookies.find((c) => c.startsWith('sf_session='))!;
    expect(session).toMatch(/HttpOnly/i);
    expect(session).toMatch(/SameSite=Lax/i);

    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.passwordHash).toMatch(/^\$argon2id\$/);
    const sub = await prisma.subscription.findUniqueOrThrow({
      where: { workspaceId: res.body.data.currentWorkspaceId },
      include: { plan: true },
    });
    expect(sub.plan.key).toBe('FREE');
    expect(await prisma.emailDelivery.count({ where: { toAddress: email, template: 'verify_email' } })).toBe(
      1,
    );

    const me = await client.get('/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.data.user.email).toBe(email);
  });

  it('rejects a duplicate email with 409', async () => {
    const { email } = await registerClient(app);
    const other = await new TestClient(app).init();
    const res = await other.post('/auth/register', {
      name: 'Dup',
      email: email.toUpperCase(),
      password: DEFAULT_PASSWORD,
      acceptTerms: true,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('returns field-level validation errors', async () => {
    const client = await new TestClient(app).init();
    const res = await client.post('/auth/register', {
      name: 'X',
      email: 'not-an-email',
      password: 'short',
      acceptTerms: false,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    const paths = res.body.error.details.map((d: { path: string }) => d.path);
    expect(paths).toEqual(expect.arrayContaining(['body.email', 'body.password', 'body.acceptTerms']));
    expect(res.body.error.requestId).toBeTruthy();
  });
});

describe('login and logout', () => {
  it('logs in, logs out and revokes the session', async () => {
    const { email } = await registerClient(app);
    const client = await new TestClient(app).init();

    const bad = await client.post('/auth/login', { email, password: 'wrong-password-123' });
    expect(bad.status).toBe(401);
    expect(bad.body.error.message).toBe('Email or password is incorrect.');

    const unknown = await client.post('/auth/login', {
      email: uniqueEmail('ghost'),
      password: DEFAULT_PASSWORD,
    });
    expect(unknown.status).toBe(401);
    expect(unknown.body.error.message).toBe(bad.body.error.message);

    const good = await client.post('/auth/login', { email, password: DEFAULT_PASSWORD });
    expect(good.status).toBe(200);
    expect((await client.get('/auth/me')).status).toBe(200);

    const out = await client.post('/auth/logout');
    expect(out.status).toBe(204);
    expect((await client.get('/auth/me')).status).toBe(401);
  });

  it('rejects disabled accounts', async () => {
    const { email } = await registerClient(app);
    await prisma.user.update({ where: { email }, data: { disabledAt: new Date(), disabledReason: 'test' } });
    const client = await new TestClient(app).init();
    const res = await client.post('/auth/login', { email, password: DEFAULT_PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_DISABLED');
  });
});

describe('rate limiting', () => {
  it('locks out repeated failed logins for one account with 429 and Retry-After', async () => {
    const strict = createTestApp({ rateLimitMultiplier: 1 });
    const client = await new TestClient(strict.app).init();
    const email = uniqueEmail('brute');
    for (let i = 0; i < 10; i++) {
      const res = await client.post('/auth/login', { email, password: `wrong-password-${i}` });
      expect(res.status).toBe(401);
    }
    const blocked = await client.post('/auth/login', { email, password: 'wrong-password-x' });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  });
});

describe('unauthorized access', () => {
  it.each(['/auth/me', '/workspaces', '/notifications', '/users/me/sessions'])(
    'GET %s requires a session',
    async (path) => {
      const res = await new TestClient(app).get(path);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    },
  );

  it('ignores forged session cookies', async () => {
    const res = await new TestClient(app).agent
      .get(`${API}/auth/me`)
      .set('Cookie', 'sf_session=' + 'A'.repeat(43));
    expect(res.status).toBe(401);
  });
});

describe('CSRF protection', () => {
  it('rejects state-changing requests without a valid token', async () => {
    const { client } = await registerClient(app);
    const missing = await client.agent.patch(`${API}/users/me`).send({ name: 'Nope' });
    expect(missing.status).toBe(403);
    expect(missing.body.error.code).toBe('CSRF_INVALID');

    const forged = await client.agent
      .patch(`${API}/users/me`)
      .set('X-CSRF-Token', 'forged.value')
      .send({ name: 'Nope' });
    expect(forged.status).toBe(403);

    const crossOrigin = await client.agent
      .patch(`${API}/users/me`)
      .set('X-CSRF-Token', client.csrf)
      .set('Origin', 'https://evil.example')
      .send({ name: 'Nope' });
    expect(crossOrigin.status).toBe(403);

    const allowed = await client.patch('/users/me', { name: 'Renamed User' });
    expect(allowed.status).toBe(200);
    expect(allowed.body.data.name).toBe('Renamed User');
  });
});

describe('email verification', () => {
  it('verifies the address with the emailed single-use token', async () => {
    const { client, email } = await registerClient(app);
    const token = await emailTokenFor(queues, email, 'verify_email');
    const res = await client.post('/auth/verify-email', { token });
    expect(res.status).toBe(200);
    expect((await client.get('/auth/me')).body.data.user.emailVerified).toBe(true);
    expect((await client.post('/auth/verify-email', { token })).status).toBe(400);
  });
});

describe('password reset', () => {
  it('does not reveal whether an account exists', async () => {
    const client = await new TestClient(app).init();
    const res = await client.post('/auth/forgot-password', { email: uniqueEmail('nobody') });
    expect(res.status).toBe(202);
  });

  it('resets the password, revokes sessions and rejects token reuse', async () => {
    const { client: loggedIn, email } = await registerClient(app);
    const anon = await new TestClient(app).init();
    expect((await anon.post('/auth/forgot-password', { email })).status).toBe(202);
    const token = await emailTokenFor(queues, email, 'password_reset');

    const weak = await anon.post('/auth/reset-password', { token, password: 'short' });
    expect(weak.status).toBe(400);

    const reset = await anon.post('/auth/reset-password', { token, password: 'a-brand-new-passphrase' });
    expect(reset.status).toBe(200);
    expect((await loggedIn.get('/auth/me')).status).toBe(401); // old session revoked

    expect((await anon.post('/auth/login', { email, password: DEFAULT_PASSWORD })).status).toBe(401);
    expect((await anon.post('/auth/login', { email, password: 'a-brand-new-passphrase' })).status).toBe(200);
    expect(
      (await anon.post('/auth/reset-password', { token, password: 'another-passphrase-1' })).status,
    ).toBe(400);
  });
});

describe('account settings', () => {
  it('changes the password and signs out other sessions only', async () => {
    const { client: first, email } = await registerClient(app);
    const second = await new TestClient(app).init();
    expect((await second.post('/auth/login', { email, password: DEFAULT_PASSWORD })).status).toBe(200);

    const wrong = await first.post('/users/me/password', {
      currentPassword: 'incorrect-pass',
      newPassword: 'next-strong-passphrase',
    });
    expect(wrong.status).toBe(400);

    const changed = await first.post('/users/me/password', {
      currentPassword: DEFAULT_PASSWORD,
      newPassword: 'next-strong-passphrase',
    });
    expect(changed.status).toBe(200);
    expect((await first.get('/auth/me')).status).toBe(200);
    expect((await second.get('/auth/me')).status).toBe(401);
  });

  it('updates notification preferences and handles deletion requests', async () => {
    const { client } = await registerClient(app);
    const prefs = await client.patch('/users/me/preferences', {
      notificationPrefs: { weeklySummary: false },
    });
    expect(prefs.body.data.notificationPrefs).toMatchObject({ weeklySummary: false, auditCompleted: true });

    const badConfirm = await client.post('/users/me/deletion-request', {
      password: DEFAULT_PASSWORD,
      confirm: 'delete',
    });
    expect(badConfirm.status).toBe(400);
    const requested = await client.post('/users/me/deletion-request', {
      password: DEFAULT_PASSWORD,
      confirm: 'DELETE',
    });
    expect(requested.status).toBe(200);
    expect(requested.body.data.deletionRequestedAt).not.toBeNull();
    const cancelled = await client.delete('/users/me/deletion-request');
    expect(cancelled.body.data.deletionRequestedAt).toBeNull();
  });
});
