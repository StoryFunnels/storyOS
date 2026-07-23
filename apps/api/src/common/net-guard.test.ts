import { beforeEach, describe, expect, it, vi } from 'vitest';

const lookupMock = vi.fn();
vi.mock('node:dns/promises', () => ({ lookup: (...args: unknown[]) => lookupMock(...args) }));

import {
  assertPublicHost,
  guardedFetch,
  ipInCidr,
  isPrivateAddress,
  readBodyCapped,
  SsrfBlockedError,
} from './net-guard';

beforeEach(() => {
  lookupMock.mockReset();
  // Default: any hostname not specifically mocked resolves to a public address —
  // the guardedFetch tests below use real-looking hostnames (example.com) purely
  // as fetch targets, not to exercise DNS resolution itself (that's covered by
  // the "assertPublicHost — DNS resolution" suite, which overrides this per test).
  lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  delete process.env.BLOCKED_CIDRS;
  delete process.env.HTTP_ACTION_ALLOW_PRIVATE_CIDRS;
});

describe('isPrivateAddress — every private/reserved range (MN-263)', () => {
  it.each([
    ['127.0.0.1', 'IPv4 loopback'],
    ['127.255.255.255', 'IPv4 loopback range'],
    ['10.0.0.1', 'IPv4 private class A'],
    ['10.255.255.255', 'IPv4 private class A upper bound'],
    ['192.168.1.1', 'IPv4 private class C'],
    ['172.16.0.1', 'IPv4 private class B lower bound'],
    ['172.31.255.255', 'IPv4 private class B upper bound'],
    ['169.254.169.254', 'IPv4 link-local / cloud metadata'],
    ['169.254.0.1', 'IPv4 link-local'],
    ['0.0.0.0', 'IPv4 unspecified'],
    ['::1', 'IPv6 loopback'],
    ['::', 'IPv6 unspecified'],
    ['fe80::1', 'IPv6 link-local'],
    ['fc00::1', 'IPv6 unique-local (fc)'],
    ['fd00::1', 'IPv6 unique-local (fd) / ULA'],
    ['::ffff:10.0.0.1', 'IPv4-mapped IPv6 private address'],
    ['::ffff:127.0.0.1', 'IPv4-mapped IPv6 loopback'],
  ])('flags %s (%s)', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '172.32.0.1', '172.15.255.255', '11.0.0.1', '2606:4700::1', '100.64.0.1'])(
    'allows public address %s',
    (ip) => {
      expect(isPrivateAddress(ip)).toBe(false);
    },
  );
});

describe('ipInCidr', () => {
  it('matches IPv4 CIDRs at various prefix lengths', () => {
    expect(ipInCidr('10.1.2.3', '10.0.0.0/8')).toBe(true);
    expect(ipInCidr('10.1.2.3', '10.1.2.3/32')).toBe(true);
    expect(ipInCidr('192.168.1.1', '10.0.0.0/8')).toBe(false);
    expect(ipInCidr('169.254.169.254', '169.254.169.254/32')).toBe(true);
    expect(ipInCidr('169.254.169.253', '169.254.169.254/32')).toBe(false);
  });

  it('matches IPv6 CIDRs', () => {
    expect(ipInCidr('fd00::1', 'fd00::/8')).toBe(true);
    expect(ipInCidr('fd12:3456::1', 'fd00::/8')).toBe(true);
    expect(ipInCidr('fe80::1', 'fd00::/8')).toBe(false);
    expect(ipInCidr('fd00:ec2::254', 'fd00:ec2::254/128')).toBe(true);
  });

  it('never matches for a malformed CIDR rather than throwing', () => {
    expect(ipInCidr('10.0.0.1', 'not-a-cidr')).toBe(false);
    expect(ipInCidr('10.0.0.1', '')).toBe(false);
  });
});

describe('assertPublicHost — literal IPs (MN-263)', () => {
  it('refuses every private/reserved literal', async () => {
    for (const ip of ['127.0.0.1', '10.0.0.5', '192.168.1.1', '172.16.0.1', '::1', 'fd00::1']) {
      await expect(assertPublicHost(ip), ip).rejects.toThrow(/private address/);
    }
  });

  it('refuses the AWS/GCP/Azure metadata IP explicitly, even from an allowlisted /16', async () => {
    await expect(assertPublicHost('169.254.169.254')).rejects.toThrow(/blocked address/);
    // The generic private-CIDR allowlist for self-host intranets must NOT let a
    // metadata IP through just because it falls inside a wide allowed range.
    await expect(
      assertPublicHost('169.254.169.254', { allowPrivateCidrs: ['169.254.0.0/16'] }),
    ).rejects.toThrow(/blocked address/);
  });

  it('refuses the AWS IMDSv2 IPv6 metadata address and ECS metadata IP', async () => {
    await expect(assertPublicHost('fd00:ec2::254')).rejects.toThrow(/blocked address/);
    await expect(assertPublicHost('169.254.170.2')).rejects.toThrow(/blocked address/);
  });

  it('refuses an operator-configured BLOCKED_CIDRS range', async () => {
    process.env.BLOCKED_CIDRS = '203.0.113.0/24';
    await expect(assertPublicHost('203.0.113.5')).rejects.toThrow(/blocked address/);
  });

  it('allows a public literal', async () => {
    await expect(assertPublicHost('8.8.8.8')).resolves.toBeUndefined();
  });

  it('HTTP_ACTION_ALLOW_PRIVATE_CIDRS lets an explicitly allowed private range through', async () => {
    await expect(assertPublicHost('10.0.5.20')).rejects.toThrow(/private address/);
    await expect(assertPublicHost('10.0.5.20', { allowPrivateCidrs: ['10.0.5.0/24'] })).resolves.toBeUndefined();
    // A private address OUTSIDE the allowed range still refuses.
    await expect(assertPublicHost('10.0.9.20', { allowPrivateCidrs: ['10.0.5.0/24'] })).rejects.toThrow(
      /private address/,
    );
  });
});

describe('assertPublicHost — DNS resolution (MN-263)', () => {
  it('refuses a hostname that resolves to a private address', async () => {
    lookupMock.mockResolvedValue([{ address: '10.1.2.3', family: 4 }]);
    await expect(assertPublicHost('intranet.example.com')).rejects.toThrow(/resolves to private address/);
  });

  it('refuses a hostname that resolves to the metadata IP', async () => {
    lookupMock.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);
    await expect(assertPublicHost('sneaky.example.com')).rejects.toThrow(/resolves to blocked address/);
  });

  it('allows a hostname that resolves only to public addresses', async () => {
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    await expect(assertPublicHost('example.com')).resolves.toBeUndefined();
  });

  it('refuses if ANY resolved address is private, even alongside a public one', async () => {
    lookupMock.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.1', family: 4 },
    ]);
    await expect(assertPublicHost('multi.example.com')).rejects.toThrow(/resolves to private address/);
  });
});

function fakeResponse(opts: { status: number; headers?: Record<string, string>; body?: string }): Response {
  const headers = new Headers(opts.headers ?? {});
  return {
    status: opts.status,
    headers,
    async text() {
      return opts.body ?? '';
    },
    body: null,
  } as unknown as Response;
}

describe('guardedFetch (MN-263)', () => {
  it('refuses file:// — only http/https are allowed', async () => {
    const fetcher = vi.fn();
    await expect(guardedFetch(fetcher, 'file:///etc/passwd', { method: 'GET', headers: {} })).rejects.toThrow(
      SsrfBlockedError,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('refuses ftp:// and other non-http(s) schemes', async () => {
    const fetcher = vi.fn();
    await expect(guardedFetch(fetcher, 'ftp://example.com/x', { method: 'GET', headers: {} })).rejects.toThrow(
      /unsupported scheme/,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('refuses a request to a private literal without calling fetch', async () => {
    const fetcher = vi.fn();
    await expect(
      guardedFetch(fetcher, 'http://127.0.0.1/admin', { method: 'GET', headers: {} }),
    ).rejects.toThrow(/private address/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('follows a redirect to a public address and returns the final response', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse({ status: 302, headers: { location: 'https://example.com/final' } }))
      .mockResolvedValueOnce(fakeResponse({ status: 200, body: 'ok' }));
    const res = await guardedFetch(fetcher, 'https://example.com/start', { method: 'GET', headers: {} });
    expect(res.status).toBe(200);
    expect(res.text).toBe('ok');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]?.[0]).toBe('https://example.com/final');
  });

  it('re-validates every redirect hop — refuses a redirect to a private address', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse({ status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } }));
    await expect(
      guardedFetch(fetcher, 'https://example.com/start', { method: 'GET', headers: {} }),
    ).rejects.toThrow(/blocked address/);
    expect(fetcher).toHaveBeenCalledTimes(1); // never reaches the redirect target
  });

  it('refuses a redirect to a private literal IP target', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse({ status: 302, headers: { location: 'http://10.0.0.5/internal' } }));
    await expect(
      guardedFetch(fetcher, 'https://example.com/start', { method: 'GET', headers: {} }),
    ).rejects.toThrow(/private address/);
  });

  it('refuses a redirect chain past maxRedirects', async () => {
    const fetcherMock = vi.fn(async (url: string) =>
      fakeResponse({ status: 302, headers: { location: `${url}x` } }),
    );
    await expect(
      guardedFetch(fetcherMock as unknown as typeof fetch, 'https://example.com/start', { method: 'GET', headers: {} }, { maxRedirects: 3 }),
    ).rejects.toThrow(/too many redirects/);
    // Initial + 3 redirect hops = 4 calls before giving up.
    expect(fetcherMock.mock.calls.length).toBe(4);
  });

  it('sends redirect: manual and re-throws a scheme downgrade to file:// mid-chain', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse({ status: 302, headers: { location: 'file:///etc/passwd' } }));
    await expect(
      guardedFetch(fetcher, 'https://example.com/start', { method: 'GET', headers: {} }),
    ).rejects.toThrow(/unsupported scheme/);
  });

  it('caps the response body at maxBodyBytes', async () => {
    const big = 'x'.repeat(100);
    const fetcher = vi.fn().mockResolvedValue(fakeResponse({ status: 200, body: big }));
    const res = await guardedFetch(
      fetcher,
      'https://example.com/big',
      { method: 'GET', headers: {} },
      { maxBodyBytes: 10 },
    );
    expect(res.text.length).toBe(10);
    expect(res.truncated).toBe(true);
  });
});

describe('readBodyCapped', () => {
  it('reads the full body when under the cap', async () => {
    const res = { body: null, async text() { return 'hello'; } };
    const { text, truncated } = await readBodyCapped(res, 100);
    expect(text).toBe('hello');
    expect(truncated).toBe(false);
  });

  it('truncates a body over the cap via text() fallback', async () => {
    const res = { body: null, async text() { return 'x'.repeat(50); } };
    const { text, truncated } = await readBodyCapped(res, 10);
    expect(text.length).toBe(10);
    expect(truncated).toBe(true);
  });

  it('truncates a streamed body at the exact byte cap', async () => {
    const encoder = new TextEncoder();
    const chunks = [encoder.encode('12345'), encoder.encode('67890'), encoder.encode('ABCDE')];
    let i = 0;
    const stream = {
      getReader() {
        return {
          async read() {
            if (i >= chunks.length) return { done: true, value: undefined };
            return { done: false, value: chunks[i++] };
          },
          async cancel() {},
        };
      },
    } as unknown as ReadableStream<Uint8Array>;
    const res = { body: stream, async text() { throw new Error('should not be called'); } };
    const { text, truncated } = await readBodyCapped(res, 8);
    expect(text).toBe('12345678');
    expect(truncated).toBe(true);
  });
});
