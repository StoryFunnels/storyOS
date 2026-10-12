import { Injectable, Logger } from '@nestjs/common';
import { codedException } from '../../common/coded-exception';
import { env } from '../../config/env';

/**
 * #262 phase 2 / #794 — the client for the PDF sidecar (Gotenberg, a headless
 * Chromium in its own container). The API posts one self-contained HTML file and
 * gets a PDF back; it never runs a browser itself.
 *
 * Gotenberg's `POST /forms/chromium/convert/html` takes the document as a
 * multipart field named `files`, filename `index.html` (checked against its
 * docs). A render that exceeds its own deadline comes back 503.
 */
export interface PdfRendererOptions {
  /** Base URL of the sidecar. Unset = PDF export is not configured on this server. */
  url?: string;
  timeoutMs: number;
  /** Renders accepted at once, running + waiting. One runs; the rest queue. */
  maxPending: number;
  /** How long a liveness probe result is reused. Default 15s. */
  statusTtlMs?: number;
}

/**
 * What a client may read BEFORE offering PDF export (#885). The names are the
 * guarantees:
 *  - `configured` — an operator has set PDF_RENDERER_URL. Says nothing about whether
 *    anything is listening.
 *  - `reachable`  — the renderer answered its health check OK at `checked_at`.
 *    `null` when not configured: nothing was asked.
 *  - `available`  — `configured && reachable`. The only one a UI should gate on.
 * A result is reused for up to `statusTtlMs`, so `available` can be up to that stale:
 * `checked_at` says exactly how stale.
 */
export interface PdfExportStatus {
  configured: boolean;
  reachable: boolean | null;
  available: boolean;
  checked_at: string | null;
}

const PROBE_TIMEOUT_MS = 2000;
const DEFAULT_STATUS_TTL_MS = 15_000;

export function pdfRendererOptionsFromEnv(): PdfRendererOptions {
  const e = env();
  return {
    url: e.PDF_RENDERER_URL?.trim() || undefined,
    timeoutMs: e.PDF_RENDER_TIMEOUT_MS,
    maxPending: e.PDF_RENDER_MAX_PENDING,
  };
}

@Injectable()
export class PdfRenderer {
  private readonly log = new Logger(PdfRenderer.name);
  /** The tail of the render chain: each render starts when the previous settles. */
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private probed: { status: PdfExportStatus; at: number } | undefined;
  private probing: Promise<PdfExportStatus> | undefined;

  constructor(private readonly options: PdfRendererOptions) {}

  get configured(): boolean {
    return Boolean(this.options.url);
  }

  /**
   * Is PDF export usable right now? Not configured costs nothing (no network). When
   * configured it asks the sidecar's own `GET /health` — which answers 200 when
   * healthy and 503 when a module is down — so a configured-but-dead renderer
   * reports `available: false` instead of advertising a button that fails.
   *
   * Concurrent callers share ONE probe, and a result is reused for `statusTtlMs`
   * (down as well as up), so a page that polls cannot turn into load on the sidecar.
   */
  async status(): Promise<PdfExportStatus> {
    if (!this.options.url) return { configured: false, reachable: null, available: false, checked_at: null };
    const ttl = this.options.statusTtlMs ?? DEFAULT_STATUS_TTL_MS;
    if (this.probed && Date.now() - this.probed.at < ttl) return this.probed.status;
    if (this.probing) return this.probing;
    this.probing = this.probe().finally(() => {
      this.probing = undefined;
    });
    return this.probing;
  }

  private async probe(): Promise<PdfExportStatus> {
    const url = `${this.options.url!.replace(/\/+$/, '')}/health`;
    let reachable: boolean;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(Math.min(PROBE_TIMEOUT_MS, this.options.timeoutMs)) });
      reachable = res.ok;
      await res.body?.cancel().catch(() => undefined);
    } catch {
      reachable = false;
    }
    const now = Date.now();
    const status: PdfExportStatus = {
      configured: true,
      reachable,
      available: reachable,
      checked_at: new Date(now).toISOString(),
    };
    this.probed = { status, at: now };
    return status;
  }

  /**
   * Render HTML to a PDF. Renders run ONE AT A TIME (#794: concurrency 1 on a
   * small host) — a burst queues instead of fanning out into parallel Chromium
   * tabs. Past `maxPending` the request is refused with a Retry-After instead of
   * queuing without bound.
   */
  async render(html: string): Promise<Buffer> {
    if (!this.options.url) {
      throw codedException(
        503,
        'pdf_export_not_configured',
        'PDF export is not configured on this server. An operator must run the PDF renderer and set PDF_RENDERER_URL.',
      );
    }
    if (this.pending >= this.options.maxPending) {
      throw codedException(503, 'pdf_export_busy', 'PDF export is busy; try again in a few seconds.', {
        retry_after_seconds: 10,
      });
    }
    this.pending += 1;
    const run = this.tail.then(
      () => this.call(html),
      () => this.call(html),
    );
    this.tail = run.catch(() => undefined);
    try {
      return await run;
    } finally {
      this.pending -= 1;
    }
  }

  private async call(html: string): Promise<Buffer> {
    const url = `${this.options.url!.replace(/\/+$/, '')}/forms/chromium/convert/html`;
    const form = new FormData();
    form.append('files', new Blob([html], { type: 'text/html' }), 'index.html');
    // The page size comes from the document's own @page rule, so the margins the
    // stylesheet promises are the margins the PDF has.
    form.append('preferCssPageSize', 'true');
    form.append('printBackground', 'true');
    form.append('emulatedMediaType', 'print');
    // The HTML references nothing external by construction, so a resource that
    // fails to load is a bug here — fail loudly rather than ship a PDF with holes.
    form.append('failOnResourceLoadingFailed', 'true');

    let res: Response;
    try {
      res = await fetch(url, { method: 'POST', body: form, signal: AbortSignal.timeout(this.options.timeoutMs) });
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw this.timeout();
      }
      this.log.error(`PDF renderer unreachable: ${(err as Error).message}`);
      throw codedException(503, 'pdf_renderer_unreachable', 'The PDF renderer is unreachable. Try again shortly.');
    }

    if (res.status === 503) {
      // Gotenberg's own deadline ("did not complete within the configured maximum duration").
      throw this.timeout();
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 500);
      this.log.error(`PDF renderer returned ${res.status}: ${detail}`);
      throw codedException(502, 'pdf_render_failed', 'The PDF renderer could not render this document.');
    }
    const pdf = Buffer.from(await res.arrayBuffer());
    if (pdf.subarray(0, 4).toString('latin1') !== '%PDF') {
      this.log.error(`PDF renderer returned a non-PDF body (${pdf.length} bytes)`);
      throw codedException(502, 'pdf_render_failed', 'The PDF renderer returned something that is not a PDF.');
    }
    return pdf;
  }

  private timeout() {
    return codedException(504, 'pdf_render_timeout', 'Rendering the PDF took too long. Try a shorter document.', {
      timeout_ms: this.options.timeoutMs,
    });
  }
}
