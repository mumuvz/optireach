import { describe, expect, it } from 'vitest';
import {
  UnsafeTargetError,
  assertUrlPolicy,
  isBlockedAddress,
  isDevAllowlisted,
  resolvePublicAddresses,
} from '../src/crawler/ssrf';

describe('isBlockedAddress', () => {
  it.each([
    '127.0.0.1',
    '127.255.255.254',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // cloud metadata
    '100.100.100.200', // CGNAT (Alibaba metadata)
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '192.0.2.10',
    '198.18.0.1',
    '::1',
    '::',
    'fe80::1',
    'fc00::1',
    'fd00:ec2::254', // AWS IPv6 metadata
    'ff02::1',
    '::ffff:127.0.0.1', // IPv4-mapped loopback
    '::ffff:7f00:1',
    '::ffff:169.254.169.254',
    '64:ff9b::a00:1', // NAT64 of 10.0.0.1
    '2002:c0a8:101::1', // 6to4 of 192.168.1.1
    '2001:db8::1',
    'not-an-ip',
  ])('blocks %s', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each([
    '93.184.215.14',
    '8.8.8.8',
    '1.1.1.1',
    '2606:4700:4700::1111',
    '2a00:1450:4001:80b::200e',
    '172.32.0.1',
    '100.128.0.1',
  ])('allows public address %s', (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });
});

describe('assertUrlPolicy', () => {
  const blocked = (url: string, allowlist: string[] = []) => {
    try {
      assertUrlPolicy(new URL(url), allowlist);
      return null;
    } catch (error) {
      return error instanceof UnsafeTargetError ? error.violation : 'OTHER';
    }
  };

  it('accepts ordinary public URLs', () => {
    expect(blocked('https://example.com/page')).toBeNull();
    expect(blocked('http://www.example.org:80/')).toBeNull();
  });

  it('rejects unsafe protocols, ports, credentials, internal names and IP literals', () => {
    expect(blocked('file:///etc/passwd')).toBe('UNSUPPORTED_PROTOCOL');
    expect(blocked('gopher://example.com/')).toBe('UNSUPPORTED_PROTOCOL');
    expect(blocked('https://user:pw@example.com/')).toBe('CREDENTIALS_IN_URL');
    expect(blocked('http://example.com:6379/')).toBe('PORT_NOT_ALLOWED');
    expect(blocked('http://localhost/')).toBe('INTERNAL_HOSTNAME');
    expect(blocked('http://metadata.google.internal/')).toBe('INTERNAL_HOSTNAME');
    expect(blocked('http://printer.local/')).toBe('INTERNAL_HOSTNAME');
    expect(blocked('http://intranet/')).toBe('INTERNAL_HOSTNAME');
    expect(blocked('http://127.0.0.1/')).toBe('PRIVATE_ADDRESS');
    expect(blocked('http://2130706433/')).toBe('PRIVATE_ADDRESS'); // decimal 127.0.0.1, normalized by URL
    expect(blocked('http://0x7f.1/')).toBe('PRIVATE_ADDRESS');
    expect(blocked('http://[::1]/')).toBe('PRIVATE_ADDRESS');
    expect(blocked('http://[::ffff:169.254.169.254]/')).toBe('PRIVATE_ADDRESS');
  });

  it('honours the explicit development allowlist only for exact host:port pairs', () => {
    expect(blocked('http://127.0.0.1:4555/', ['127.0.0.1:4555'])).toBeNull();
    expect(blocked('http://127.0.0.1:4556/', ['127.0.0.1:4555'])).toBe('PORT_NOT_ALLOWED');
    expect(isDevAllowlisted(new URL('http://localhost:3000/'), ['localhost:*'])).toBe(true);
    expect(isDevAllowlisted(new URL('http://localhost:3000/'), [])).toBe(false);
  });
});

describe('resolvePublicAddresses', () => {
  it('rejects hostnames that resolve to any private address (DNS rebinding style answers)', async () => {
    const resolver = async () => [
      { address: '93.184.215.14', family: 4 as const },
      { address: '10.0.0.5', family: 4 as const },
    ];
    await expect(resolvePublicAddresses('evil.example', { resolver })).rejects.toMatchObject({
      violation: 'PRIVATE_ADDRESS',
    });
  });

  it('returns public addresses and reports DNS failures', async () => {
    const ok = await resolvePublicAddresses('good.example', {
      resolver: async () => [{ address: '93.184.215.14', family: 4 }],
    });
    expect(ok).toEqual([{ address: '93.184.215.14', family: 4 }]);
    await expect(
      resolvePublicAddresses('missing.example', {
        resolver: async () => {
          throw new Error('ENOTFOUND');
        },
      }),
    ).rejects.toMatchObject({ violation: 'DNS_FAILURE' });
  });
});
