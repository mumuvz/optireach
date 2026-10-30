import { describe, expect, it } from 'vitest';
import {
  createPkcePair,
  decryptSecret,
  encryptSecret,
  hashPassword,
  hashToken,
  hmacSha256,
  randomToken,
  safeEqual,
  verifyPassword,
} from '../src/crypto';
import { EnvValidationError, parseEnv } from '../src/env';

const KEY = Buffer.alloc(32, 7).toString('base64');

const baseEnv = {
  APP_URL: 'http://localhost:5173',
  API_URL: 'http://localhost:4000',
  DATABASE_URL: 'mysql://u:p@localhost:3306/app',
  SESSION_SECRET: 'x'.repeat(40),
  ENCRYPTION_KEY: KEY,
};

describe('parseEnv', () => {
  it('applies defaults and treats empty strings as unset', () => {
    const env = parseEnv({ ...baseEnv, OPENAI_MODEL: '', GOOGLE_CLIENT_ID: '' });
    expect(env.API_PORT).toBe(4000);
    expect(env.OPENAI_MODEL).toBe('gpt-5.4-mini');
    expect(env.GOOGLE_CLIENT_ID).toBeUndefined();
    expect(env.BILLING_PROVIDER).toBe('none');
    expect(env.cookieSecure).toBe(false);
  });

  it('rejects a short session secret and a malformed encryption key', () => {
    expect(() => parseEnv({ ...baseEnv, SESSION_SECRET: 'short' })).toThrow(EnvValidationError);
    expect(() => parseEnv({ ...baseEnv, ENCRYPTION_KEY: 'bm90LTMyLWJ5dGVz' })).toThrow(/ENCRYPTION_KEY/);
  });

  it('requires provider credentials for the selected providers', () => {
    expect(() => parseEnv({ ...baseEnv, LLM_PROVIDER: 'openai' })).toThrow(/OPENAI_API_KEY/);
    expect(() => parseEnv({ ...baseEnv, BILLING_PROVIDER: 'stripe' })).toThrow(/STRIPE_SECRET_KEY/);
    expect(() => parseEnv({ ...baseEnv, EMAIL_PROVIDER: 'smtp' })).toThrow(/SMTP_HOST/);
  });

  it('blocks development-only modes in production', () => {
    const prod = {
      ...baseEnv,
      NODE_ENV: 'production',
      CORS_ALLOWED_ORIGINS: 'https://app.example.com',
      EMAIL_PROVIDER: 'smtp',
      SMTP_HOST: 'smtp.example.com',
      LLM_PROVIDER: 'none',
    };
    expect(parseEnv(prod).cookieSecure).toBe(true);
    expect(() => parseEnv({ ...prod, BILLING_PROVIDER: 'dev' })).toThrow(/Development billing/);
    expect(() => parseEnv({ ...prod, AI_DEMO_MODE: 'true' })).toThrow(/Demo AI/);
    expect(() => parseEnv({ ...prod, LLM_PROVIDER: 'dev' })).toThrow(/development LLM/);
    expect(() => parseEnv({ ...prod, LOCAL_RANK_FIXTURES: 'true' })).toThrow(/local rank results/);
    // A localhost custom collector in production is the demo mock pattern and is refused unless explicitly allowed.
    const loopback = { ...prod, SERP_PROVIDER: 'custom', CUSTOM_SERP_URL: 'http://127.0.0.1:4600/collect' };
    expect(() => parseEnv(loopback)).toThrow(/CUSTOM_SERP_URL points at localhost/);
    expect(parseEnv({ ...loopback, CUSTOM_SERP_ALLOW_LOOPBACK: 'true' }).SERP_PROVIDER).toBe('custom');
    // A real remote collector is accepted.
    expect(parseEnv({ ...prod, SERP_PROVIDER: 'custom', CUSTOM_SERP_URL: 'https://collector.example.com/collect' }).SERP_PROVIDER).toBe('custom'); // prettier-ignore
    // The crawler dev allowlist is ignored in production even if set.
    expect(parseEnv({ ...prod, CRAWLER_DEV_ALLOWLIST: '127.0.0.1:4555' }).crawlerDevAllowlist).toEqual([]);
  });
});

describe('test environment isolation', () => {
  it('never exposes real provider credentials to automated tests', async () => {
    const { getEnv } = await import('../src/env');
    const env = getEnv();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.PERPLEXITY_API_KEY).toBeUndefined();
    expect(env.STRIPE_SECRET_KEY).toBeUndefined();
    expect(env.GOOGLE_CLIENT_SECRET).toBeUndefined();
    expect(env.LLM_PROVIDER).toBe('dev');
    expect(env.DATABASE_URL).toMatch(/_test(\?|$)/);
  });
});

describe('crypto helpers', () => {
  it('round-trips AES-256-GCM secrets and detects tampering', () => {
    const payload = encryptSecret('ya29.secret-token', KEY);
    expect(payload).not.toContain('secret-token');
    expect(decryptSecret(payload, KEY)).toBe('ya29.secret-token');
    const parts = payload.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => decryptSecret(parts.join('.'), KEY)).toThrow();
    expect(encryptSecret('same', KEY)).not.toBe(encryptSecret('same', KEY)); // random IV
  });

  it('hashes and verifies passwords with Argon2id', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword(hash, 'correct horse battery staple')).toBe(true);
    expect(await verifyPassword(hash, 'wrong password')).toBe(false);
    expect(await verifyPassword('not-a-hash', 'x')).toBe(false);
  });

  it('generates unguessable tokens and stable hashes', () => {
    const a = randomToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(a);
    expect(hashToken(a)).toHaveLength(64);
    expect(hashToken(a)).toBe(hashToken(a));
    expect(safeEqual(hmacSha256('k', 'data'), hmacSha256('k', 'data'))).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });

  it('creates an S256 PKCE pair', () => {
    const { verifier, challenge } = createPkcePair();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
