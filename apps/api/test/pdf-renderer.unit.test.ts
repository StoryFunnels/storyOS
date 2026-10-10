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

async function status(p: Promise<unknown>): Promise<{ status: number; message: string }> {
  try {
    await p;
  } catch (e) {
    const err = e as { getStatus?: () => number; message?: string };
    return { status: err.getStatus?.() ?? 0, message: String(err.message) };
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
