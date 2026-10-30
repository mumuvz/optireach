import argon2 from 'argon2';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { getEnv } from './env';

/** Cryptographically random URL-safe token (default 256 bits). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

export function hmacSha256(secret: string | Buffer, data: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

/** Constant-time string comparison (returns false for different lengths without leaking timing of content). */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    // Compare against itself to keep timing similar, then fail.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

/** Hash for storing session/reset/invitation/OAuth-state tokens: never store the raw token. */
export function hashToken(token: string): string {
  return sha256Hex(token);
}

/** Pseudonymous IP hash for abuse limits (keyed so it cannot be reversed with a rainbow table). */
export function hashIp(ip: string): string {
  return sha256Hex(`${getEnv().SESSION_SECRET}:ip:${ip}`);
}

// ---------- AES-256-GCM for secrets at rest (OAuth tokens, PKCE verifiers) ----------

const ENC_VERSION = 'v1';

function encryptionKey(keyBase64?: string): Buffer {
  const key = Buffer.from(keyBase64 ?? getEnv().ENCRYPTION_KEY, 'base64');
  if (key.length !== 32) throw new Error('ENCRYPTION_KEY must decode to 32 bytes');
  return key;
}

/** Returns "v1.<iv>.<tag>.<ciphertext>" (base64url parts). */
export function encryptSecret(plaintext: string, keyBase64?: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(keyBase64), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    ENC_VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

export function decryptSecret(payload: string, keyBase64?: string): string {
  const [version, iv, tag, data] = payload.split('.');
  if (version !== ENC_VERSION || !iv || !tag || data === undefined)
    throw new Error('Unsupported encrypted payload');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(keyBase64), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}

// ---------- Passwords (Argon2id, OWASP-recommended parameters) ----------

const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

/** A fixed hash used to equalize login timing when the email does not exist. */
let dummyHash: Promise<string> | null = null;
export function getDummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword(randomToken(16));
  return dummyHash;
}

/** PKCE (RFC 7636) code verifier and S256 challenge. */
export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomToken(48);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}
