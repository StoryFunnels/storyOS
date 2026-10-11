import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { PdfRenderer } from '../src/documents/export/pdf-renderer';

/**
 * #262 / #794 — the sidecar client, against stub servers. No DB, no app.
 *
 * The properties that matter on a small host: renders run ONE AT A TIME, a burst
 * is refused rather than queued without bound, a hung renderer cannot hang a
 * request, and every failure maps to an honest status instead of a bare 500.
 */
const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

async function stub(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const ok = (_req: unknown, res: import('node:http').ServerResponse) => {
  res.writeHead(200, { 'content-type': 'application/pdf' }).end('%PDF-1.4 stub');
};

const opts = (url: string | undefined, over: Partial<{ timeoutMs: number; maxPending: number }> = {}) => ({
  url,
  timeoutMs: 2000,
  maxPending: 4,
  ...over,
});

async function status(p: Promise<unknown>): Promise<{ status: number; message: string; code?: string; meta?: Record<string, unknown> }> {
  try {
    await p;
  } catch (e) {
    const err = e as { getStatus?: () => number; message?: string; getResponse?: () => unknown };
    const body = (err.getResponse?.() ?? {}) as { code?: string; meta?: Record<string, unknown> };
    return { status: err.getStatus?.() ?? 0, message: String(err.message), code: body.code, meta: body.meta };
  }
  throw new Error('expected the render to fail');
}

describe('PdfRenderer', () => {
  it('returns the PDF bytes on success, and tolerates a trailing slash on the base URL', async () => {
    const url = await stub(ok);
    const pdf = await new PdfRenderer(opts(`${url}/`)).render('<html></html>');
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('is not configured without a URL: 503 that says what to set, never a mysterious failure', async () => {
    const r = new PdfRenderer(opts(undefined));
    expect(r.configured).toBe(false);
    const f = await status(r.render('<html></html>'));
    expect(f.status).toBe(503);
    expect(f.message).toContain('PDF_RENDERER_URL');
  });

  it('a renderer that never answers becomes 504 at the timeout, not a hung request', async () => {
    const url = await stub(() => undefined); // accepts and never responds
    const started = Date.now();
    const f = await status(new PdfRenderer(opts(url, { timeoutMs: 300 })).render('x'));
    expect(f.status).toBe(504);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('the sidecar\'s own deadline (503) is reported as 504, our gateway-timeout, not passed through as "unavailable"', async () => {
    const url = await stub((_q, res) => void res.writeHead(503).end('did not complete'));
    expect((await status(new PdfRenderer(opts(url)).render('x'))).status).toBe(504);
  });

  it('any other renderer failure is 502 with a generic message — the sidecar\'s internals are not echoed', async () => {
    const url = await stub((_q, res) => void res.writeHead(400).end('net::ERR_NAME_NOT_RESOLVED secret-internal-detail'));
    const f = await status(new PdfRenderer(opts(url)).render('x'));
    expect(f.status).toBe(502);
    expect(f.message).not.toContain('secret-internal-detail');
  });

  it('a 200 that is not a PDF is 502, not a corrupt download', async () => {
    const url = await stub((_q, res) => void res.writeHead(200).end('<html>an error page</html>'));
    expect((await status(new PdfRenderer(opts(url)).render('x'))).status).toBe(502);
  });

  it('an unreachable renderer is 503', async () => {
    const dead = await stub(ok);
    servers.pop()!.close(); // free the port, then point at it
    expect((await status(new PdfRenderer(opts(dead)).render('x'))).status).toBe(503);
  });

  it('runs renders ONE AT A TIME — three concurrent requests never overlap at the sidecar', async () => {
    let running = 0;
    let peak = 0;
    const url = await stub((_q, res) => {
      running += 1;
      peak = Math.max(peak, running);
      setTimeout(() => {
        running -= 1;
        ok(_q, res);
      }, 80);
    });
    const r = new PdfRenderer(opts(url));
    const all = await Promise.all([r.render('a'), r.render('b'), r.render('c')]);
    expect(all).toHaveLength(3);
    expect(peak).toBe(1);
  });

  it('refuses past maxPending with a retry hint instead of queuing without bound', async () => {
    const url = await stub((_q, res) => void setTimeout(() => ok(_q, res), 200));
    const r = new PdfRenderer(opts(url, { maxPending: 2 }));
    const first = r.render('a');
    const second = r.render('b');
    const third = await status(r.render('c'));
    expect(third.status).toBe(503);
    expect(third.message).toContain('busy');
    await Promise.all([first, second]); // the accepted ones still complete
  });

  it('a failed render does not wedge the queue behind it', async () => {
    let calls = 0;
    const url = await stub((q, res) => {
      calls += 1;
      if (calls === 1) res.writeHead(400).end('nope');
      else ok(q, res);
    });
    const r = new PdfRenderer(opts(url));
    const bad = status(r.render('a'));
    const good = r.render('b');
    expect((await bad).status).toBe(502);
    expect((await good).subarray(0, 4).toString()).toBe('%PDF');
  });
});

describe('every refusal carries a specific code a client can branch on (#885)', () => {
  it('not configured / busy / timeout / unreachable / render failed are five DIFFERENT codes, not 503 + prose', async () => {
    const codes: Record<string, string | undefined> = {};
    codes.notConfigured = (await status(new PdfRenderer(opts(undefined)).render('x'))).code;

    const slow = await stub((_q, res) => void setTimeout(() => ok(_q, res), 200));
    const busyR = new PdfRenderer(opts(slow, { maxPending: 1 }));
    const first = busyR.render('a');
    codes.busy = (await status(busyR.render('b'))).code;
    await first;

    const hang = await stub(() => undefined);
    codes.timeout = (await status(new PdfRenderer(opts(hang, { timeoutMs: 200 })).render('x'))).code;

    const dead = await stub(ok);
    servers.pop()!.close();
    codes.unreachable = (await status(new PdfRenderer(opts(dead)).render('x'))).code;

    const bad = await stub((_q, res) => void res.writeHead(400).end('x'));
    codes.failed = (await status(new PdfRenderer(opts(bad)).render('x'))).code;

    expect(codes).toEqual({
      notConfigured: 'pdf_export_not_configured',
      busy: 'pdf_export_busy',
      timeout: 'pdf_render_timeout',
      unreachable: 'pdf_renderer_unreachable',
      failed: 'pdf_render_failed',
    });
  });

  it('the busy refusal carries its retry interval as a FIELD, and the timeout carries its limit', async () => {
    const slow = await stub((_q, res) => void setTimeout(() => ok(_q, res), 200));
    const r = new PdfRenderer(opts(slow, { maxPending: 1 }));
    const first = r.render('a');
    expect((await status(r.render('b'))).meta).toEqual({ retry_after_seconds: 10 });
    await first;

    const hang = await stub(() => undefined);
    expect((await status(new PdfRenderer(opts(hang, { timeoutMs: 300 })).render('x'))).meta).toEqual({ timeout_ms: 300 });
  });
});

describe('PdfRenderer.status — availability is REACHABILITY, not "a variable is set" (#885)', () => {
  const healthy = (_q: unknown, res: import('node:http').ServerResponse) => {
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"up"}');
  };

  it('not configured: available false, nothing asked of the network, nothing to report a time for', async () => {
    expect(await new PdfRenderer(opts(undefined)).status()).toEqual({
      configured: false,
      reachable: null,
      available: false,
      checked_at: null,
    });
  });

  it('configured and healthy: available true, with the time it was checked', async () => {
    const url = await stub(healthy);
    const s = await new PdfRenderer(opts(url)).status();
    expect(s).toMatchObject({ configured: true, reachable: true, available: true });
    expect(Date.parse(s.checked_at!)).toBeGreaterThan(Date.now() - 5000);
  });

  it('configured but the renderer reports itself unhealthy (503): NOT available — the defect #885 exists to remove', async () => {
    const url = await stub((_q, res) => void res.writeHead(503).end('{"status":"down"}'));
    expect(await new PdfRenderer(opts(url)).status()).toMatchObject({ configured: true, reachable: false, available: false });
  });

  it('configured but nothing is listening: NOT available', async () => {
    const dead = await stub(healthy);
    servers.pop()!.close();
    expect(await new PdfRenderer(opts(dead)).status()).toMatchObject({ configured: true, reachable: false, available: false });
  });

  it('configured but the health check hangs: NOT available, and the probe gives up (bounded wait)', async () => {
    const hang = await stub(() => undefined);
    const started = Date.now();
    const s = await new PdfRenderer(opts(hang, { timeoutMs: 300 })).status();
    expect(s.available).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('probes the sidecar\'s /health route, not the render route', async () => {
    const seen: string[] = [];
    const url = await stub((q, res) => {
      seen.push(`${q.method} ${q.url}`);
      healthy(q, res);
    });
    await new PdfRenderer(opts(url)).status();
    expect(seen).toEqual(['GET /health']);
  });

  it('reuses a result for the TTL — a polling page cannot become load on the sidecar — and re-checks after it', async () => {
    let probes = 0;
    const url = await stub((q, res) => {
      probes += 1;
      healthy(q, res);
    });
    const r = new PdfRenderer({ ...opts(url), statusTtlMs: 120 });
    await r.status();
    await r.status();
    await r.status();
    expect(probes).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 160));
    await r.status();
    expect(probes).toBe(2);
  });

  it('concurrent callers share ONE probe', async () => {
    let probes = 0;
    const url = await stub((q, res) => {
      probes += 1;
      setTimeout(() => healthy(q, res), 60);
    });
    const r = new PdfRenderer(opts(url));
    const all = await Promise.all([r.status(), r.status(), r.status(), r.status()]);
    expect(probes).toBe(1);
    expect(new Set(all.map((s) => s.checked_at)).size).toBe(1);
  });

  it('a DOWN result is reused too, then recovers when the renderer comes back', async () => {
    let up = false;
    const url = await stub((q, res) => (up ? healthy(q, res) : void res.writeHead(503).end('{}')));
    const r = new PdfRenderer({ ...opts(url), statusTtlMs: 120 });
    expect((await r.status()).available).toBe(false);
    up = true;
    expect((await r.status()).available).toBe(false); // still inside the TTL: reused, not re-asked
    await new Promise((resolve) => setTimeout(resolve, 160));
    expect((await r.status()).available).toBe(true);
  });
});
