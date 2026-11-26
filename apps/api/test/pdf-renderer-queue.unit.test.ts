import { createServer } from 'node:http';
import type { Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { PdfRenderer } from '../src/documents/export/pdf-renderer';

/**
 * Ticket #877 — an automation's renders queue PER WORKSPACE (the ruling: 25, failing loudly past that), through the same
 * single-file renderer the interactive export uses. Stub sidecar, no DB, no app.
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

const ok = (_req: unknown, res: ServerResponse) => {
  res.writeHead(200, { 'content-type': 'application/pdf' }).end('%PDF-1.4 stub');
};

const opts = (url: string, over: Partial<{ timeoutMs: number; maxPending: number }> = {}) => ({
  url,
  timeoutMs: 2000,
  maxPending: 4,
  ...over,
});

async function refusal(p: Promise<unknown>): Promise<{ status: number; message: string; code?: string; meta?: Record<string, unknown> }> {
  try {
    await p;
  } catch (e) {
    const err = e as { getStatus?: () => number; message?: string; getResponse?: () => unknown };
    const body = (err.getResponse?.() ?? {}) as { code?: string; meta?: Record<string, unknown> };
    return { status: err.getStatus?.() ?? 0, message: String(err.message), code: body.code, meta: body.meta };
  }
  throw new Error('expected the render to fail');
}

describe('PdfRenderer: an automation queue per workspace (#877)', () => {
  it('accepts up to the limit per key, then refuses with pdf_queue_full and a figure, never a timeout', async () => {
    const url = await stub((q, res) => void setTimeout(() => ok(q, res), 120));
    const r = new PdfRenderer(opts(url, { maxPending: 1 }));
    // maxPending is the INTERACTIVE ceiling; the queue path is bounded by its own limit instead.
    const queued = [1, 2, 3].map(() => r.render('h', { key: 'ws-a', limit: 3 }));
    const fourth = await refusal(r.render('h', { key: 'ws-a', limit: 3 }));
    expect(fourth.status).toBe(503);
    expect(fourth.code).toBe('pdf_queue_full');
    expect(fourth.meta).toEqual({ limit: 3 });
    expect(fourth.message).toContain('(3)');
    await Promise.all(queued); // the accepted three all complete
  });

  it('the limit is per key: another workspace is not refused because this one is full', async () => {
    const url = await stub((q, res) => void setTimeout(() => ok(q, res), 120));
    const r = new PdfRenderer(opts(url));
    const accepted = [r.render('h', { key: 'ws-a', limit: 1 })];
    expect((await refusal(r.render('h', { key: 'ws-a', limit: 1 }))).code).toBe('pdf_queue_full');
    accepted.push(r.render('h', { key: 'ws-b', limit: 1 }));
    expect((await Promise.all(accepted)).length).toBe(2);
  });

  it('frees the slot when a render finishes or fails, so the queue does not shrink for good', async () => {
    let calls = 0;
    const url = await stub((q, res) => {
      calls += 1;
      if (calls === 1) res.writeHead(400).end('nope');
      else ok(q, res);
    });
    const r = new PdfRenderer(opts(url));
    expect((await refusal(r.render('h', { key: 'ws-a', limit: 1 }))).status).toBe(502);
    expect((await r.render('h', { key: 'ws-a', limit: 1 })).subarray(0, 4).toString()).toBe('%PDF');
    expect((await r.render('h', { key: 'ws-a', limit: 1 })).subarray(0, 4).toString()).toBe('%PDF');
  });

  it('queued renders still run ONE AT A TIME, and still count toward the interactive busy answer', async () => {
    let running = 0;
    let peak = 0;
    const url = await stub((q, res) => {
      running += 1;
      peak = Math.max(peak, running);
      setTimeout(() => {
        running -= 1;
        ok(q, res);
      }, 60);
    });
    const r = new PdfRenderer(opts(url, { maxPending: 2 }));
    const queued = [1, 2, 3].map(() => r.render('h', { key: 'ws-a', limit: 25 }));
    // A person asking while three are pending is told "busy", not let jump the queue.
    expect((await refusal(r.render('person'))).code).toBe('pdf_export_busy');
    await Promise.all(queued);
    expect(peak).toBe(1);
  });
});
