import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';

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

/**
 * #1036 — outgoing webhooks go through the same guarded, address-pinned transport as the http_request action, and a redirect is NEVER
 * followed: it used to be plain `fetch`, which follows them (a 307/308 replays the signed POST at the new target, and the status code
 * a person sees is an oracle for what answers on an internal port). A 3xx is simply a failed delivery.
 */
export const defaultWebhookFetcher: WebhookFetcher = async (url, init) => {
  const res = await guardedFetch(undefined, url, init, { followRedirects: false, maxBodyBytes: 1024 });
  return { status: res.status };
};

/**
 * True for every address a server must never be made to call on a stranger's behalf: loopback, private, link-local, unique-local, shared
 * address space (CGNAT / Tailscale), benchmarking, multicast and reserved ranges, NAT64, and IPv6 forms that EMBED an IPv4 address
 * (IPv4-mapped in either spelling, 6to4), which are judged by the IPv4 address they carry.
 */
export function isPrivateAddress(address: string): boolean {
  const v = isIP(address.replace(/^\[|\]$/g, ''));
  if (v === 4) {
    const [a, b] = address.split('.').map(Number) as [number, number];
    return (
      a === 127 || a === 10 || a === 0 || (a === 192 && b === 168) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 100 && b >= 64 && b <= 127) || // 100.64.0.0/10 shared address space: CGNAT, Tailscale
      (a === 198 && (b === 18 || b === 19)) || // 198.18.0.0/15 benchmarking
      (a === 192 && b === 0) || // 192.0.0.0/24 IETF protocol assignments and 192.0.2.0/24 documentation
      a >= 224 // 224.0.0.0/4 multicast and 240.0.0.0/4 reserved (incl. 255.255.255.255)
    );
  }
  const host = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (isIP(host) !== 6) return false;
  const parts = ipv6ToParts(host);
  if (!parts) return true; // an IPv6 literal we cannot parse is not one we will call
  const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  // ::/96 (unspecified, loopback, the deprecated IPv4-compatible form) and ::ffff:0:0/96 (IPv4-mapped): the embedded IPv4 decides, and
  // everything in ::/96 is refused outright.
  if (parts.slice(0, 5).every((x) => x === 0)) {
    if (parts[5] === 0) return true;
    if (parts[5] === 0xffff) return isPrivateAddress(v4(parts[6]!, parts[7]!));
  }
  return (
    (parts[0]! & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (parts[0]! & 0xffc0) === 0xfec0 || // fec0::/10 site-local (deprecated, still routed by some stacks)
    (parts[0]! & 0xfe00) === 0xfc00 || // fc00::/7 unique-local
    (parts[0]! & 0xff00) === 0xff00 || // ff00::/8 multicast
    (parts[0] === 0x0064 && parts[1] === 0xff9b && parts.slice(2, 6).every((x) => x === 0)) || // 64:ff9b::/96 NAT64 (reaches the IPv4 it embeds)
    (parts[0] === 0x2002 && isPrivateAddress(v4(parts[1]!, parts[2]!))) // 2002::/16 6to4: judged by the IPv4 it wraps
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

/** Throws SsrfBlockedError unless `address` may be called. The blocklists always win; the self-host allowlist only widens what is "private". */
function checkAddress(address: string, via: string | null, allow: string[]): void {
  const blocked = [...METADATA_BLOCKLIST, ...envCidrList('BLOCKED_CIDRS')];
  const from = via ? `${via} — it resolves to ` : '';
  if (blocked.some((c) => ipInCidr(address, c))) {
    throw new SsrfBlockedError(`refusing to call ${from}blocked address ${address}`);
  }
  if (allow.some((c) => ipInCidr(address, c))) return; // explicit self-host opt-in
  if (isPrivateAddress(address)) {
    throw new SsrfBlockedError(`refusing to call ${from}private address ${address}`);
  }
}

export async function assertPublicHost(
  hostname: string,
  opts?: { allowPrivateCidrs?: string[] },
): Promise<void> {
  const allow = opts?.allowPrivateCidrs ?? [];
  const bare = hostname.replace(/^\[|\]$/g, '');
  if (isIP(bare)) {
    checkAddress(bare, null, allow);
    return;
  }
  const results = await lookup(hostname, { all: true });
  for (const { address } of results) checkAddress(address, hostname, allow);
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

/**
 * #1036 — the transport that closes the DNS-rebinding window. The old flow resolved the name to CHECK it, then handed the URL to
 * `fetch`, which resolved it AGAIN to connect: a name that answers public the first time and 169.254.169.254 (or a Docker address)
 * the second walked straight past the check. Here the connection's own `lookup` is the check: the name is resolved ONCE, every address
 * it returned is judged, and the socket is opened to one of those exact addresses (the Host header and TLS name stay the original
 * hostname). There is no second resolution to poison. Used for every hop of every redirect, because every hop is a new connection.
 */
export function pinnedFetch(opts: { allowPrivateCidrs?: string[] } = {}): typeof fetch {
  const allow = opts.allowPrivateCidrs ?? [];
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (!ALLOWED_SCHEMES.has(url.protocol)) throw new SsrfBlockedError(`unsupported scheme "${url.protocol}" — only http/https are allowed`);
    // An IP literal never reaches `lookup` (nothing to resolve), so it is judged here.
    const literal = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(literal)) checkAddress(literal, null, allow);

    const guardedLookup = (
      hostname: string,
      options: { all?: boolean } | number | undefined,
      cb: (err: Error | null, address?: string | Array<{ address: string; family: number }>, family?: number) => void,
    ) => {
      lookup(hostname, { all: true })
        .then((results) => {
          if (results.length === 0) throw new SsrfBlockedError(`${hostname} did not resolve`);
          for (const { address } of results) checkAddress(address, hostname, allow);
          const wantAll = typeof options === 'object' && options?.all;
          if (wantAll) cb(null, results.map((r) => ({ address: r.address, family: r.family })));
          else cb(null, results[0]!.address, results[0]!.family);
        })
        .catch((e: unknown) => cb(e instanceof Error ? e : new Error(String(e))));
    };

    const headers: Record<string, string> = {};
    new Headers(init?.headers as HeadersInit | undefined).forEach((v, k) => { headers[k] = v; });
    const body = init?.body == null ? undefined : typeof init.body === 'string' ? init.body : String(init.body);
    return await new Promise<Response>((resolve, reject) => {
      const lib = url.protocol === 'https:' ? https : http;
      const req = lib.request(
        url,
        { method: init?.method ?? 'GET', headers, lookup: guardedLookup as never, agent: false, signal: init?.signal ?? undefined },
        (res) => {
          const out = new Headers();
          for (let i = 0; i < res.rawHeaders.length; i += 2) out.append(res.rawHeaders[i]!, res.rawHeaders[i + 1]!);
          const status = res.statusCode ?? 0;
          const noBody = status === 204 || status === 205 || status === 304 || (status >= 100 && status < 200);
          resolve(new Response(noBody ? null : (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>), { status, statusText: res.statusMessage ?? '', headers: out }));
        },
      );
      req.on('error', reject);
      if (body !== undefined) req.write(body);
      req.end();
    });
  }) as typeof fetch;
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
  /** Only with `opts.binary`: the body as raw bytes (`text` is then empty). `truncated` says the cap was hit. */
  bytes?: Buffer;
}

/** Like readBodyCapped but keeps the raw bytes (a file, not text) and stops reading the moment the cap is exceeded. */
export async function readBytesCapped(
  res: { body: ReadableStream<Uint8Array> | null; arrayBuffer(): Promise<ArrayBuffer> },
  maxBytes: number,
): Promise<{ bytes: Buffer; truncated: boolean }> {
  if (!res.body) {
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > maxBytes ? { bytes: buf.subarray(0, maxBytes), truncated: true } : { bytes: buf, truncated: false };
  }
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.length;
    if (total > maxBytes) {
      chunks.push(Buffer.from(value.subarray(0, value.length - (total - maxBytes))));
      try { await reader.cancel(); } catch { /* the response is being discarded */ }
      return { bytes: Buffer.concat(chunks), truncated: true };
    }
    chunks.push(Buffer.from(value));
  }
  return { bytes: Buffer.concat(chunks), truncated: false };
}

/**
 * MN-263 — the http_request action's send path: scheme-checks, resolves +
 * SSRF-checks the host, sends with `redirect: 'manual'`, and re-validates
 * every redirect hop (the original assertPublicHost-once-before-send pattern
 * can't see a 302 pointed at a private/metadata address — this can). Caps
 * redirects at `maxRedirects` and the response body at `maxBodyBytes`.
 */
export async function guardedFetch(
  fetcherArg: typeof fetch | undefined,
  initialUrl: string,
  init: GuardedFetchInit,
  opts: {
    allowPrivateCidrs?: string[];
    maxRedirects?: number;
    maxBodyBytes?: number;
    followRedirects?: boolean;
    binary?: boolean;
    /** Header names (case-insensitive) to drop when a redirect leaves the origin the request started on. `Authorization`, `Cookie` and `Proxy-Authorization` are ALWAYS dropped there. */
    stripOnCrossOrigin?: string[];
  } = {},
): Promise<GuardedFetchResult> {
  // #1036: the real network transport is ALWAYS the address-pinned one. A caller that passes the global `fetch` (every production
  // caller does) gets it here, so no caller has to remember to opt in; only a test's stub is used as given.
  const fetcher = fetcherArg && fetcherArg !== globalThis.fetch ? fetcherArg : pinnedFetch({ allowPrivateCidrs: opts.allowPrivateCidrs });
  const maxRedirects = opts.maxRedirects ?? 3;
  const maxBodyBytes = opts.maxBodyBytes ?? 1_000_000;
  let url = initialUrl;
  let headers = init.headers;
  const dropOnLeave = new Set(['authorization', 'proxy-authorization', 'cookie', ...(opts.stripOnCrossOrigin ?? []).map((h) => h.toLowerCase())]);
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
      headers,
      body: init.body,
      redirect: 'manual',
      signal: init.signal,
    });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get('location');
      if (!location || opts.followRedirects === false) {
        const { text, truncated } = await readBodyCapped(res, maxBodyBytes);
        return { status: res.status, headers: res.headers, finalUrl: url, text, truncated };
      }
      if (hop === maxRedirects) {
        throw new SsrfBlockedError(`too many redirects (> ${maxRedirects})`);
      }
      const next = new URL(location, url);
      // #1035 — credentials follow a redirect only within the origin they were sent to: a 302 to another host must not carry them.
      if (next.origin !== new URL(url).origin) {
        headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !dropOnLeave.has(k.toLowerCase())));
      }
      url = next.toString();
      continue;
    }
    if (opts.binary) {
      const { bytes, truncated } = await readBytesCapped(res, maxBodyBytes);
      return { status: res.status, headers: res.headers, finalUrl: url, text: '', truncated, bytes };
    }
    const { text, truncated } = await readBodyCapped(res, maxBodyBytes);
    return { status: res.status, headers: res.headers, finalUrl: url, text, truncated };
  }
  throw new SsrfBlockedError('too many redirects');
}
