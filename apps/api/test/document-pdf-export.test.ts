import { createServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { authed, signUpUser } from './helpers/users';
import { PdfRenderer } from '../src/documents/export/pdf-renderer';

/**
 * #262 phase 2 — GET .../documents/:doc/export/pdf, through the real HTTP route
 * against a STUB of the sidecar (Gotenberg, #794).
 *
 * What this does and does not prove. It proves everything on OUR side of the wire:
 * access, the HTML we post (structure, escaping, inlined images, no external
 * references), the multipart shape Gotenberg documents, headers, the image-leak and
 * SSRF guards. It does NOT prove Chromium lays the page out well — the stub returns
 * a fixed `%PDF` body. A real render is a separate, manual check.
 *
 * `env()` is evaluated when AppModule is imported, so PDF_RENDERER_URL must be set
 * BEFORE the app is imported — hence the dynamic import in beforeAll.
 */
let app: NestFastifyApplication;
let owner: { token: string };
let outsider: { token: string };
let otherOwner: { token: string };
let wsId: string;
let otherWsId: string;
let spaceId: string;

let sidecar: Server;
let canary: Server;
let received: { html: string; fields: Record<string, string>; contentType: string }[] = [];
let canaryHits = 0;
/** Stub controls: how long a render takes, and whether the sidecar's /health says it is up. */
let renderDelayMs = 0;
let healthUp = true;

const BOUNDARY = 'X-PDF-TEST-BOUNDARY';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

/** Minimal multipart reader — enough to pull out the `files` part and the plain fields. */
function parseMultipart(body: Buffer, contentType: string) {
  const boundary = /boundary=(.+)$/.exec(contentType)?.[1] ?? '';
  const text = body.toString('utf8');
  const fields: Record<string, string> = {};
  let html = '';
  for (const part of text.split(`--${boundary}`)) {
    const m = /content-disposition: form-data; name="([^"]+)"(?:; filename="([^"]+)")?/i.exec(part);
    if (!m) continue;
    const value = part.slice(part.indexOf('\r\n\r\n') + 4).replace(/\r\n$/, '');
    if (m[1] === 'files' && m[2] === 'index.html') html = value;
    else fields[m[1]!] = value;
  }
  return { html, fields };
}

function multipartFile(filename: string, mime: string, data: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`--${BOUNDARY}\r\ncontent-disposition: form-data; name="file"; filename="${filename}"\r\ncontent-type: ${mime}\r\n\r\n`),
    data,
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
  ]);
}

async function as(token: string, method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
}

async function uploadImage(ws: string, token: string) {
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/workspaces/${ws}/files`,
    headers: { ...authed(token), 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
    payload: multipartFile('pixel.png', 'image/png', PNG),
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; url: string };
}

const t = (s: string) => [{ type: 'text' as const, text: s, styles: {} }];

/**
 * A user with a workspace, a space, and a personal access token of their own.
 *
 * The export route is rate-limited, and the limiter keys a PAT on its own bucket but every
 * SESSION request on the client IP — which `app.inject` shares across the whole file. So the
 * many-exports describe blocks call the route with a PAT (a dedicated bucket each, the same
 * reason the other throttled routes' tests take a dedicated app), and make documents with the
 * session token (that route is not throttled this tightly).
 */
interface Ctx { token: string; pat: string; wsId: string; spaceId: string }
async function freshContext(name: string): Promise<Ctx> {
  const user = await signUpUser(app, name);
  const ws = (await as(user.token, 'POST', '/workspaces', { name: `${name} WS` })).json().id as string;
  const space = (await as(user.token, 'GET', `/workspaces/${ws}/spaces`)).json()[0].id as string;
  const minted = await as(user.token, 'POST', '/me/tokens', { name: `${name} pat`, workspace_id: ws });
  expect(minted.statusCode, minted.body).toBeLessThan(300);
  return { token: user.token, pat: minted.json().token as string, wsId: ws, spaceId: space };
}
const mainCtx = (): Ctx => ({ token: owner.token, pat: owner.token, wsId, spaceId });

/** A document in the context's workspace, with `content`. Returns its id. */
async function makeDoc(title: string, content: unknown, ctx: Ctx = mainCtx()): Promise<string> {
  const created = await as(ctx.token, 'POST', `/workspaces/${ctx.wsId}/spaces/${ctx.spaceId}/documents`, { title });
  expect(created.statusCode, created.body).toBe(201);
  const id = created.json().id as string;
  const patched = await as(ctx.token, 'PATCH', `/workspaces/${ctx.wsId}/documents/${id}`, {
    expected_version: created.json().version,
    content,
  });
  expect(patched.statusCode, patched.body).toBe(200);
  return id;
}

const exportPdf = (token: string, docId: string, ws: string = wsId) =>
  as(token, 'GET', `/workspaces/${ws}/documents/${docId}/export/pdf`);

beforeAll(async () => {
  sidecar = createServer(async (req, res) => {
    const body = await readBody(req);
    const contentType = String(req.headers['content-type'] ?? '');
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(healthUp ? 200 : 503, { 'content-type': 'application/json' });
      res.end(healthUp ? '{"status":"up"}' : '{"status":"down"}');
      return;
    }
    if (req.method === 'POST' && req.url === '/forms/chromium/convert/html') {
      received.push({ ...parseMultipart(body, contentType), contentType });
      if (renderDelayMs) await new Promise((r) => setTimeout(r, renderDelayMs));
      res.writeHead(200, { 'content-type': 'application/pdf' });
      res.end('%PDF-1.4 stub');
      return;
    }
    res.writeHead(404).end();
  });
  // Any request here means the API followed a URL a user typed into a document.
  canary = createServer((_req, res) => {
    canaryHits += 1;
    res.writeHead(200, { 'content-type': 'image/png' }).end(PNG);
  });
  const sidecarPort = await listen(sidecar);
  await listen(canary);

  process.env.PDF_RENDERER_URL = `http://127.0.0.1:${sidecarPort}`;
  process.env.PDF_RENDER_TIMEOUT_MS = '5000';

  const { createTestApp } = await import('./helpers/app');
  app = await createTestApp();
  owner = await signUpUser(app, 'PdfExportOwner');
  outsider = await signUpUser(app, 'PdfExportOutsider');
  otherOwner = await signUpUser(app, 'PdfExportOtherOwner');

  wsId = (await as(owner.token, 'POST', '/workspaces', { name: 'PDF Export WS' })).json().id;
  otherWsId = (await as(otherOwner.token, 'POST', '/workspaces', { name: 'PDF Other WS' })).json().id;
  spaceId = (await as(owner.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
});

afterAll(async () => {
  await app?.close();
  sidecar?.close();
  canary?.close();
});

describe('GET .../documents/:doc/export/pdf (#262 phase 2)', () => {
  it('returns the renderer\'s PDF with download headers and a slugged filename', async () => {
    const id = await makeDoc('Runbook: Incident Response', [{ type: 'paragraph', content: t('Page the on-call engineer.') }]);
    const res = await exportPdf(owner.token, id);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toContain('Runbook-Incident-Response.pdf');
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
    expect(res.headers['x-storyos-export-skipped-images']).toBeUndefined();
  });

  it('posts ONE self-contained HTML file named index.html, as Gotenberg documents', async () => {
    received = [];
    const id = await makeDoc('Shape check', [{ type: 'paragraph', content: t('hello') }]);
    await exportPdf(owner.token, id);
    expect(received).toHaveLength(1);
    expect(received[0]!.contentType).toContain('multipart/form-data');
    expect(received[0]!.html).toContain('<h1 class="doc-title">Shape check</h1>');
    // The page size/margins come from the document's own @page rule.
    expect(received[0]!.fields.preferCssPageSize).toBe('true');
    expect(received[0]!.fields.failOnResourceLoadingFailed).toBe('true');
    // Nothing external: no stylesheet link, no remote script, no remote image.
    expect(received[0]!.html).not.toMatch(/<link\b|<script\b|src="https?:/i);
  });

  it('keeps nested lists, a divider, a toggle body and a table — what the serializer fix (#822) also keeps', async () => {
    received = [];
    const id = await makeDoc('Everything', [
      { type: 'bulletListItem', content: t('parent'), children: [{ type: 'bulletListItem', content: t('NESTED-CHILD') }] },
      { type: 'divider' },
      { type: 'toggleListItem', content: t('toggle title'), children: [{ type: 'paragraph', content: t('INSIDE-TOGGLE') }] },
      {
        type: 'table',
        content: { type: 'tableContent', headerRows: 1, rows: [{ cells: [t('H1'), t('H2')] }, { cells: [t('CELL-A'), t('CELL-B')] }] },
      },
    ]);
    const res = await exportPdf(owner.token, id);
    expect(res.statusCode, res.body).toBe(200);
    const html = received[0]!.html;
    for (const s of ['parent', 'NESTED-CHILD', 'toggle title', 'INSIDE-TOGGLE', 'CELL-A', 'CELL-B']) expect(html).toContain(s);
    expect(html).toContain('<hr>');
    expect(html).toContain('<thead>');
  });

  it('escapes document text — a document cannot inject markup into the page the browser renders', async () => {
    received = [];
    const id = await makeDoc('<img src=x onerror=alert(1)>', [
      { type: 'paragraph', content: t('<script>alert("pwned")</script>') },
      { type: 'paragraph', content: [{ type: 'link', href: 'javascript:alert(1)', content: t('click me') }] },
    ]);
    await exportPdf(owner.token, id);
    const html = received[0]!.html;
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('click me');
  });

  it('inlines an uploaded editor image as a data URI, straight from storage', async () => {
    received = [];
    const file = await uploadImage(wsId, owner.token);
    const id = await makeDoc('With image', [{ type: 'image', props: { url: file.url, caption: 'a pixel' } }]);
    const res = await exportPdf(owner.token, id);
    expect(res.statusCode, res.body).toBe(200);
    expect(received[0]!.html).toContain(`data:image/png;base64,${PNG.toString('base64')}`);
    expect(received[0]!.html).toContain('a pixel');
    expect(res.headers['x-storyos-export-skipped-images']).toBeUndefined();
  });

  it('accepts the absolute form of an editor image URL too (the web app stores either)', async () => {
    received = [];
    const file = await uploadImage(wsId, owner.token);
    const id = await makeDoc('Absolute url', [{ type: 'image', props: { url: `http://localhost:3001${file.url}` } }]);
    await exportPdf(owner.token, id);
    expect(received[0]!.html).toContain('data:image/png;base64,');
  });

  it('does NOT fetch an external image URL — placeholder + a count, and the canary is never hit', async () => {
    received = [];
    const port = (canary.address() as AddressInfo).port;
    // Prove the canary can SEE a hit before relying on it seeing none.
    await fetch(`http://127.0.0.1:${port}/self-check`);
    expect(canaryHits).toBe(1);
    canaryHits = 0;
    const id = await makeDoc('SSRF probe', [{ type: 'image', props: { url: `http://127.0.0.1:${port}/steal.png`, caption: 'external' } }]);
    const res = await exportPdf(owner.token, id);
    expect(res.statusCode, res.body).toBe(200);
    expect(canaryHits).toBe(0);
    expect(received[0]!.html).toContain('[Image not included: external]');
    expect(received[0]!.html).not.toContain('data:image');
    expect(res.headers['x-storyos-export-skipped-images']).toBe('1');
  });

  it('does NOT inline ANOTHER workspace\'s image, even with a valid file URL — no cross-tenant leak', async () => {
    received = [];
    const foreign = await uploadImage(otherWsId, otherOwner.token);
    const id = await makeDoc('Leak probe', [{ type: 'image', props: { url: foreign.url, caption: 'theirs' } }]);
    const res = await exportPdf(owner.token, id);
    expect(res.statusCode, res.body).toBe(200);
    expect(received[0]!.html).not.toContain('data:image');
    expect(received[0]!.html).toContain('[Image not included: theirs]');
    expect(res.headers['x-storyos-export-skipped-images']).toBe('1');
  });

  it('a non-member gets 404, not the PDF and not a 403 — same no-existence-leak convention as the Markdown route', async () => {
    const id = await makeDoc('Private', [{ type: 'paragraph', content: t('secret') }]);
    received = [];
    const res = await exportPdf(outsider.token, id);
    expect(res.statusCode).toBe(404);
    expect(received).toHaveLength(0);
  });

  it('refuses a document whose own text is too large for a small host\'s browser (413), without calling the renderer', async () => {
    received = [];
    // "&" escapes to "&amp;" — a 1.5 MB body becomes ~7.5 MB of HTML, past the 6 MB cap.
    const id = await makeDoc('Huge', [{ type: 'paragraph', content: t('&'.repeat(1_500_000)) }]);
    const res = await exportPdf(owner.token, id);
    expect(res.statusCode).toBe(413);
    expect(received).toHaveLength(0);
  });
});

/** The renderer's options are readonly in production; a test flips them on the live instance and restores. */
function withRenderer<T>(patch: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
  const renderer = app.get(PdfRenderer) as unknown as { options: Record<string, unknown> };
  const original = renderer.options;
  renderer.options = { ...original, ...patch };
  return fn().finally(() => {
    renderer.options = original;
  });
}

const capabilities = (token?: string) =>
  app.inject({ method: 'GET', url: '/api/v1/capabilities', headers: token ? authed(token) : {} });

describe('GET /capabilities advertises availability (#885)', () => {
  let ctx: Ctx;
  beforeAll(async () => {
    ctx = await freshContext('PdfCapabilitiesOwner');
  });

  it('requires a signed-in user — it describes the deployment\'s infrastructure', async () => {
    expect((await capabilities()).statusCode).toBe(401);
  });

  it('configured and the sidecar is healthy: available, with when it was checked', async () => {
    healthUp = true;
    const res = await withRenderer({ statusTtlMs: 0 }, () => capabilities(ctx.pat));
    expect(res.statusCode, res.body).toBe(200);
    const pdf = res.json().pdf_export;
    expect(pdf).toMatchObject({ configured: true, reachable: true, available: true });
    expect(Date.parse(pdf.checked_at)).toBeGreaterThan(Date.now() - 10_000);
  });

  it('configured but the sidecar is DOWN: NOT available — the control must not be offered', async () => {
    healthUp = false;
    try {
      const res = await withRenderer({ statusTtlMs: 0 }, () => capabilities(ctx.pat));
      expect(res.json().pdf_export).toMatchObject({ configured: true, reachable: false, available: false });
    } finally {
      healthUp = true;
    }
  });

  it('NOT CONFIGURED — production\'s only state today: available false, and the export route still answers a clean 503, never a 500', async () => {
    const id = await makeDoc('Unconfigured', [{ type: 'paragraph', content: t('x') }], ctx);
    await withRenderer({ url: undefined }, async () => {
      const cap = await capabilities(ctx.pat);
      expect(cap.statusCode).toBe(200);
      expect(cap.json().pdf_export).toEqual({ configured: false, reachable: null, available: false, checked_at: null });

      const res = await exportPdf(ctx.pat, id, ctx.wsId);
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe('pdf_export_not_configured');
      expect(res.json().error.message).toContain('PDF_RENDERER_URL');
    });
  });
});

describe('every PDF refusal reaches the client as a distinct code with its figures (#885)', () => {
  let ctx: Ctx;
  beforeAll(async () => {
    ctx = await freshContext('PdfRefusalsOwner');
  });

  it('413: the limit and the measured size are FIELDS, not just prose', async () => {
    const id = await makeDoc('Huge, with figures', [{ type: 'paragraph', content: t('&'.repeat(1_500_000)) }], ctx);
    const res = await exportPdf(ctx.pat, id, ctx.wsId);
    expect(res.statusCode).toBe(413);
    const err = res.json().error;
    expect(err.code).toBe('document_too_large');
    expect(err.meta.unit).toBe('characters');
    expect(err.meta.limit).toBe(6_000_000);
    expect(typeof err.meta.measured).toBe('number');
    expect(err.meta.measured).toBeGreaterThan(err.meta.limit);
    // The figures are also readable in the message, but a client must never need to parse it.
    expect(err.message).toContain('too large');
  });

  it('503 busy: a distinct code, the interval as a field AND as a real Retry-After header', async () => {
    renderDelayMs = 500;
    const id = await makeDoc('Busy', [{ type: 'paragraph', content: t('x') }], ctx);
    try {
      const [a, b] = await withRenderer({ maxPending: 1 }, () => Promise.all([exportPdf(ctx.pat, id, ctx.wsId), exportPdf(ctx.pat, id, ctx.wsId)]));
      const statuses = [a.statusCode, b.statusCode].sort();
      expect(statuses).toEqual([200, 503]);
      const busy = a.statusCode === 503 ? a : b;
      expect(busy.json().error.code).toBe('pdf_export_busy');
      expect(busy.json().error.meta).toEqual({ retry_after_seconds: 10 });
      expect(busy.headers['retry-after']).toBe('10');
    } finally {
      renderDelayMs = 0;
    }
  });

  it('504: a distinct code with the limit that was exceeded', async () => {
    renderDelayMs = 1500;
    const id = await makeDoc('Slow', [{ type: 'paragraph', content: t('x') }], ctx);
    try {
      const res = await withRenderer({ timeoutMs: 300 }, () => exportPdf(ctx.pat, id, ctx.wsId));
      expect(res.statusCode).toBe(504);
      expect(res.json().error.code).toBe('pdf_render_timeout');
      expect(res.json().error.meta).toEqual({ timeout_ms: 300 });
    } finally {
      renderDelayMs = 0;
    }
  });

  it('the happy path is unchanged: still a PDF', async () => {
    const id = await makeDoc('Still works', [{ type: 'paragraph', content: t('x') }], ctx);
    const res = await exportPdf(ctx.pat, id, ctx.wsId);
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
  });
});
