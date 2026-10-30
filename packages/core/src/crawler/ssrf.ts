// Server-side request forgery (SSRF) protection for every outbound fetch of a user-supplied URL.
// Policy:
//  - http/https only, no embedded credentials, ports 80/443 only;
//  - no internal hostnames (localhost, *.local, *.internal, single-label names, ...);
//  - every resolved address must be public (blocks loopback, private, CGNAT, link-local incl. cloud
//    metadata 169.254.169.254, multicast, reserved, documentation and translation ranges);
//  - callers connect to the *validated* address (see fetcher.ts), which defeats DNS rebinding.
// A development-only allowlist (CRAWLER_DEV_ALLOWLIST, ignored in production) permits explicit
// host:port pairs such as the local E2E fixture site.
import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { getEnv } from '../env';

const v4 = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  v4.addSubnet(network, prefix, 'ipv4');
}

const v6 = new BlockList();
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['100::', 64],
  ['2001::', 32],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const) {
  v6.addSubnet(network, prefix, 'ipv6');
}

/** Expands an IPv6 address into eight 16-bit groups (handles "::" and dotted IPv4 tails). */
function ipv6Groups(address: string): number[] | null {
  let addr = address.toLowerCase().split('%')[0] ?? '';
  const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(addr);
  if (dotted?.[1]) {
    const parts = dotted[1].split('.').map(Number);
    if (parts.some((p) => p > 255)) return null;
    const hex = `${((parts[0]! << 8) | parts[1]!).toString(16)}:${((parts[2]! << 8) | parts[3]!).toString(16)}`;
    addr = addr.slice(0, addr.length - dotted[1].length) + hex;
  }
  const [head, tail] = addr.split('::');
  const headGroups = head ? head.split(':') : [];
  const tailGroups = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const missing = 8 - headGroups.length - tailGroups.length;
  if (addr.includes('::') ? missing < 1 : headGroups.length !== 8) return null;
  const groups = [...headGroups, ...Array(addr.includes('::') ? missing : 0).fill('0'), ...tailGroups].map(
    (g) => parseInt(g, 16),
  );
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff)
    ? groups
    : null;
}

function embeddedIpv4(groups: number[]): string | null {
  const toV4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  const zeroPrefix = groups.slice(0, 5).every((g) => g === 0);
  // ::ffff:a.b.c.d (IPv4-mapped) and ::a.b.c.d (deprecated IPv4-compatible)
  if (zeroPrefix && (groups[5] === 0xffff || groups[5] === 0)) return toV4(groups[6]!, groups[7]!);
  // 64:ff9b::/96 NAT64 well-known prefix
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((g) => g === 0))
    return toV4(groups[6]!, groups[7]!);
  // 2002::/16 6to4 embeds the IPv4 address in groups 1–2
  if (groups[0] === 0x2002) return toV4(groups[1]!, groups[2]!);
  return null;
}

/** True when the address must never be contacted (non-public or malformed). */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address.split('%')[0] ?? '');
  if (family === 4) return v4.check(address, 'ipv4');
  if (family === 6) {
    const groups = ipv6Groups(address);
    if (!groups) return true;
    const mapped = embeddedIpv4(groups);
    if (mapped) return isBlockedAddress(mapped);
    // NAT64 local-use prefix 64:ff9b:1::/48 may reach internal networks.
    if (groups[0] === 0x64 && groups[1] === 0xff9b && groups[2] === 1) return true;
    return v6.check(address, 'ipv6');
  }
  return true;
}

const BLOCKED_HOST_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.intranet',
  '.lan',
  '.home',
  '.corp',
  '.localdomain',
  '.home.arpa',
];
const ALLOWED_PORTS = new Set(['', '80', '443']);

export type PolicyViolation =
  | 'UNSUPPORTED_PROTOCOL'
  | 'CREDENTIALS_IN_URL'
  | 'PORT_NOT_ALLOWED'
  | 'INTERNAL_HOSTNAME'
  | 'PRIVATE_ADDRESS'
  | 'DNS_FAILURE';

export class UnsafeTargetError extends Error {
  constructor(
    public readonly violation: PolicyViolation,
    message: string,
  ) {
    super(message);
    this.name = 'UnsafeTargetError';
  }
}

function hostPortKey(url: URL): string {
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  return `${url.hostname.toLowerCase().replace(/^\[|\]$/g, '')}:${port}`;
}

/** Development/test allowlist: entries like "127.0.0.1:4555" or "localhost:*". Always empty in production. */
export function isDevAllowlisted(url: URL, allowlist: string[] = getEnv().crawlerDevAllowlist): boolean {
  if (allowlist.length === 0) return false;
  const key = hostPortKey(url);
  const host = key.slice(0, key.lastIndexOf(':'));
  return allowlist.some((entry) => entry === key || entry === `${host}:*`);
}

/** Synchronous checks that need no DNS (protocol, credentials, port, hostname shape, IP literals). */
export function assertUrlPolicy(url: URL, allowlist?: string[]): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UnsafeTargetError('UNSUPPORTED_PROTOCOL', 'Only http and https URLs can be crawled.');
  }
  if (url.username || url.password)
    throw new UnsafeTargetError('CREDENTIALS_IN_URL', 'URLs with credentials are not allowed.');
  if (isDevAllowlisted(url, allowlist)) return;
  if (!ALLOWED_PORTS.has(url.port)) {
    throw new UnsafeTargetError(
      'PORT_NOT_ALLOWED',
      'Only the standard web ports (80 and 443) can be crawled.',
    );
  }
  const host = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (isIP(host)) {
    if (isBlockedAddress(host))
      throw new UnsafeTargetError(
        'PRIVATE_ADDRESS',
        'Private, local or reserved addresses cannot be crawled.',
      );
    return;
  }
  if (host === 'localhost' || !host.includes('.') || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) {
    throw new UnsafeTargetError('INTERNAL_HOSTNAME', 'Internal or local hostnames cannot be crawled.');
  }
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

export const systemResolver: Resolver = async (hostname) => {
  const results = await dnsLookup(hostname, { all: true, verbatim: true });
  return results.map((r) => ({ address: r.address, family: r.family === 6 ? 6 : 4 }));
};

/**
 * Resolves a hostname and returns only if *every* address is public (an attacker-controlled DNS
 * name that returns one public and one private address is rejected outright).
 */
export async function resolvePublicAddresses(
  hostname: string,
  { resolver = systemResolver, allowPrivate = false }: { resolver?: Resolver; allowPrivate?: boolean } = {},
): Promise<ResolvedAddress[]> {
  const host = hostname.replace(/^\[|\]$/g, '');
  const literal = isIP(host);
  let addresses: ResolvedAddress[];
  if (literal) {
    addresses = [{ address: host, family: literal === 6 ? 6 : 4 }];
  } else {
    try {
      addresses = await resolver(host);
    } catch {
      throw new UnsafeTargetError('DNS_FAILURE', `Could not resolve ${host}.`);
    }
  }
  if (addresses.length === 0) throw new UnsafeTargetError('DNS_FAILURE', `${host} has no DNS records.`);
  if (!allowPrivate && addresses.some((a) => isBlockedAddress(a.address))) {
    throw new UnsafeTargetError('PRIVATE_ADDRESS', `${host} resolves to a private or reserved address.`);
  }
  return addresses;
}
