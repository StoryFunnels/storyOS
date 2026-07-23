import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * MN-263 — the SSRF guard every outbound-HTTP path in the API shares.
 *
 * Originally lived inline in webhooks/webhook-sender.ts (MN-032/088):
 * `isPrivateAddress` + `assertPublicHost`, checked once before a send. Moved
 * here verbatim (webhook-sender.ts now imports them back — no behavior change
 * for outgoing webhooks) and extended for the http_request automation action
 * (MN-263), which is a strictly riskier surface: a rule author supplies an
 * arbitrary templated URL, so the guard needs to survive a redirect chase and
 * needs an explicit self-host allowlist the webhook path has no reason to
 * expose.
 *
 * Extensions over the original:
 *  - `assertPublicHost` takes an `allowPrivateCidrs` list (HTTP_ACTION_ALLOW_
 *    PRIVATE_CIDRS, wired ONLY by the http_request executor) that lets a
 *    self-hosted deployment call its own intranet. The explicit blocklist
 *    (metadata addresses, BLOCKED_CIDRS) is checked BEFORE the allowlist and
 *    is never bypassable by it — an intranet allowlist is not a metadata-theft
 *    allowlist.
 *  - `guardedFetch` re-validates on every redirect hop (the pre-send check
 *    alone can't see a 302 pointed at 169.254.169.254) and enforces http/https
 *    only, capped at `maxRedirects` hops.
 *  - `readBodyCapped` bounds how much of a response body is ever buffered.
 */

/** Minimal fetch surface so delivery is testable without a network (mirrors SlackFetcher). */
export type WebhookFetcher = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ status: number }>;

export const defaultWebhookFetcher: WebhookFetcher = (url, init) =>
  fetch(url, init) as unknown as Promise<{ status: number }>;

/** True for loopback, private, link-local and unique-local addresses. */
export function isPrivateAddress(address: string): boolean {
  const v = isIP(address);
  if (v === 4) {
    const [a, b] = address.split('.').map(Number) as [number, number];
    return (
      a === 127 || a === 10 || a === 0 || (a === 192 && b === 168) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31)
    );
  }
  const host = address.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    host === '::1' ||
    host === '::' ||
    host.startsWith('fe80:') ||
    host.startsWith('fc') ||
    host.startsWith('fd') ||
    // ::ffff:10.0.0.1 — an IPv4 address wearing an IPv6 hat
    (host.startsWith('::ffff:') && isPrivateAddress(host.slice(7)))
  );
}

// ── CIDR matching (BLOCKED_CIDRS / HTTP_ACTION_ALLOW_PRIVATE_CIDRS) ─────────

function ipv4ToInt(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    const v = Number(part);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = (n << 8) | v;
  }
  return n >>> 0;
}

/** Expands an IPv6 address (already stripped of a `[...]` wrapper) to 8 hextets. */
function ipv6ToParts(address: string): number[] | null {
  let addr = address;
  // ::ffff:1.2.3.4 — normalize the embedded IPv4 tail to hex hextets first.
  const v4Tail = /(?:^|:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(addr);
  if (v4Tail) {
    const n = ipv4ToInt(v4Tail[1]!);
    if (n === null) return null;
    const hi = ((n >>> 16) & 0xffff).toString(16);
    const lo = (n & 0xffff).toString(16);
    addr = addr.slice(0, addr.length - v4Tail[1]!.length) + `${hi}:${lo}`;
  }
  const halves = addr.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':').filter((s) => s.length > 0) : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':').filter((s) => s.length > 0) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 && head.length !== 8) return null;
  if (halves.length === 2 && missing < 0) return null;
  const zeros = halves.length === 2 ? new Array(missing).fill('0') : [];
  const hextets = [...head, ...zeros, ...tail];
  if (hextets.length !== 8) return null;
  const out: number[] = [];
  for (const h of hextets) {
    const v = parseInt(h, 16);
    if (!Number.isInteger(v) || v < 0 || v > 0xffff) return null;
    out.push(v);
  }
  return out;
}

interface ParsedCidr {
  family: 4 | 6;
  base: number | number[];
  prefix: number;
}

function parseCidr(cidr: string): ParsedCidr | null {
  const [rawAddr, rawPrefix] = cidr.trim().split('/');
  if (!rawAddr) return null;
  const addr = rawAddr.replace(/^\[|\]$/g, '');
  const family = isIP(addr);
  if (family === 4) {
    const base = ipv4ToInt(addr);
    if (base === null) return null;
    const prefix = rawPrefix !== undefined ? Number(rawPrefix) : 32;
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
    return { family: 4, base, prefix };
  }
  if (family === 6) {
    const base = ipv6ToParts(addr);
    if (!base) return null;
    const prefix = rawPrefix !== undefined ? Number(rawPrefix) : 128;
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 128) return null;
    return { family: 6, base, prefix };
  }
  return null;
}

/** Whether `address` falls inside `cidr` (e.g. `10.0.0.5` in `10.0.0.0/8`). Malformed
 * CIDRs (a typo'd env var) never match anything rather than throwing. */
export function ipInCidr(address: string, cidr: string): boolean {
  const parsed = parseCidr(cidr);
  if (!parsed) return false;
  const host = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (parsed.family === 4) {
    const ip = ipv4ToInt(host);
    if (ip === null) return false;
    if (parsed.prefix === 0) return true;
    const mask = parsed.prefix === 32 ? 0xffffffff : (~0 << (32 - parsed.prefix)) >>> 0;
    return (ip & mask) >>> 0 === ((parsed.base as number) & mask) >>> 0;
  }
  const parts = ipv6ToParts(host);
  if (!parts) return false;
  const base = parsed.base as number[];
  let remaining = parsed.prefix;
  for (let i = 0; i < 8; i++) {
    if (remaining <= 0) return true;
    const bits = Math.min(16, remaining);
    const mask = bits === 16 ? 0xffff : (~0 << (16 - bits)) & 0xffff;
    if ((parts[i]! & mask) !== (base[i]! & mask)) return false;
    remaining -= bits;
  }
  return true;
}

/**
 * MN-263 — cloud-metadata endpoints specifically, kept explicit (not just
 * relying on the generic link-local/ULA check above) so a future edit to
 * `isPrivateAddress` can't accidentally stop covering the single most
 * dangerous class of SSRF target: the credential-vending metadata service.
 */
const METADATA_BLOCKLIST = [
  '169.254.169.254/32', // AWS/GCP/Azure/DigitalOcean IMDS
  '169.254.170.2/32', // AWS ECS task metadata
  '100.100.100.200/32', // Alibaba Cloud metadata
  'fd00:ec2::254/128', // AWS IMDSv2 over IPv6
  'fe80::a9fe:a9fe/128', // link-local-mapped 169.254.169.254
];

// Read directly off process.env, NOT the memoized env() (config/env.ts caches its
// parse on first call — these two are read per-call by design, both so a test can
// toggle them freely and so an operator's edit takes effect without a full reboot
// of the env() singleton).
function envCidrList(name: 'BLOCKED_CIDRS' | 'HTTP_ACTION_ALLOW_PRIVATE_CIDRS'): string[] {
  const raw = process.env[name] ?? '';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * The URL schema rejects literal private hosts at save time, but a *name* can
 * resolve into private space (or be re-pointed after saving). Since the server
 * makes this request, resolving before each send is what stops a webhook (or
 * an http_request action) from becoming an SSRF probe into our own network.
 *
 * `allowPrivateCidrs` (MN-263): an explicit, caller-supplied opt-in — pass it
 * only from the http_request action's send path (HTTP_ACTION_ALLOW_PRIVATE_
 * CIDRS), never from webhook-sender.ts. It only widens what `isPrivateAddress`
 * would otherwise refuse; the metadata/BLOCKED_CIDRS denylist below is checked
 * first and always wins.
 */
/**
 * MN-263 — a refusal from this guard, as opposed to a transient network failure.
 * Distinguishing the two matters to a caller that retries: an SSRF refusal will
 * refuse identically on every retry (the same private/blocked/unsupported-scheme
 * target), so http-request-action.service.ts treats it as non-retryable, unlike
 * a DNS blip or connection reset from the same `fetch` call.
 */
export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfBlockedError';
  }
}

export async function assertPublicHost(
  hostname: string,
  opts?: { allowPrivateCidrs?: string[] },
): Promise<void> {
  const allow = opts?.allowPrivateCidrs ?? [];
  const blocked = [...METADATA_BLOCKLIST, ...envCidrList('BLOCKED_CIDRS')];
  const check = (address: string) => {
    if (blocked.some((c) => ipInCidr(address, c))) {
      throw new SsrfBlockedError(`refusing to call blocked address ${address}`);
    }
    if (allow.some((c) => ipInCidr(address, c))) return; // explicit self-host opt-in
    if (isPrivateAddress(address)) {
      throw new SsrfBlockedError(`refusing to call private address ${address}`);
    }
  };
  if (isIP(hostname)) {
    check(hostname);
    return;
  }
  const results = await lookup(hostname, { all: true });
  for (const { address } of results) {
    if (blocked.some((c) => ipInCidr(address, c))) {
      throw new SsrfBlockedError(`refusing to call ${hostname} — it resolves to blocked address ${address}`);
    }
    if (allow.some((c) => ipInCidr(address, c))) continue;
    if (isPrivateAddress(address)) {
      throw new SsrfBlockedError(`refusing to call ${hostname} — it resolves to private address ${address}`);
    }
  }
}

const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

/** Bounds how much of a response body is ever buffered in memory. Reads via the
 * stream reader so an oversized response is cut off rather than fully downloaded
 * then truncated. */
export async function readBodyCapped(
  res: { body: ReadableStream<Uint8Array> | null; text(): Promise<string> },
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) {
    const text = await res.text();
    return text.length > maxBytes ? { text: text.slice(0, maxBytes), truncated: true } : { text, truncated: false };
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.length;
    if (total > maxBytes) {
      chunks.push(value.subarray(0, value.length - (total - maxBytes)));
      truncated = true;
      try {
        await reader.cancel();
      } catch {
        // best-effort — the response is already being discarded
      }
      break;
    }
    chunks.push(value);
  }
  return { text: Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8'), truncated };
}

export interface GuardedFetchInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export interface GuardedFetchResult {
  status: number;
  headers: Headers;
  finalUrl: string;
  text: string;
  truncated: boolean;
}

/**
 * MN-263 — the http_request action's send path: scheme-checks, resolves +
 * SSRF-checks the host, sends with `redirect: 'manual'`, and re-validates
 * every redirect hop (the original assertPublicHost-once-before-send pattern
 * can't see a 302 pointed at a private/metadata address — this can). Caps
 * redirects at `maxRedirects` and the response body at `maxBodyBytes`.
 */
export async function guardedFetch(
  fetcher: typeof fetch,
  initialUrl: string,
  init: GuardedFetchInit,
  opts: { allowPrivateCidrs?: string[]; maxRedirects?: number; maxBodyBytes?: number } = {},
): Promise<GuardedFetchResult> {
  const maxRedirects = opts.maxRedirects ?? 3;
  const maxBodyBytes = opts.maxBodyBytes ?? 1_000_000;
  let url = initialUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new SsrfBlockedError(`invalid URL "${url}"`);
    }
    if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
      throw new SsrfBlockedError(`unsupported scheme "${parsed.protocol}" — only http/https are allowed`);
    }
    await assertPublicHost(parsed.hostname, { allowPrivateCidrs: opts.allowPrivateCidrs });
    const res = await fetcher(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      redirect: 'manual',
      signal: init.signal,
    });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get('location');
      if (!location) {
        const { text, truncated } = await readBodyCapped(res, maxBodyBytes);
        return { status: res.status, headers: res.headers, finalUrl: url, text, truncated };
      }
      if (hop === maxRedirects) {
        throw new SsrfBlockedError(`too many redirects (> ${maxRedirects})`);
      }
      url = new URL(location, url).toString();
      continue;
    }
    const { text, truncated } = await readBodyCapped(res, maxBodyBytes);
    return { status: res.status, headers: res.headers, finalUrl: url, text, truncated };
  }
  throw new SsrfBlockedError('too many redirects');
}
