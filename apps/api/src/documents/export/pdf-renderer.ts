import {
  BadGatewayException,
  GatewayTimeoutException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
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
}

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

  constructor(private readonly options: PdfRendererOptions) {}

  get configured(): boolean {
    return Boolean(this.options.url);
  }

  /**
   * Render HTML to a PDF. Renders run ONE AT A TIME (#794: concurrency 1 on a
   * small host) — a burst queues instead of fanning out into parallel Chromium
   * tabs. Past `maxPending` the request is refused with a Retry-After instead of
   * queuing without bound.
   */
  async render(html: string): Promise<Buffer> {
    if (!this.options.url) {
      throw new ServiceUnavailableException(
        'PDF export is not configured on this server. An operator must run the PDF renderer and set PDF_RENDERER_URL.',
      );
    }
    if (this.pending >= this.options.maxPending) {
      throw new HttpException(
        { message: 'PDF export is busy; try again in a few seconds.', retry_after_seconds: 10 },
        HttpStatus.SERVICE_UNAVAILABLE,
        { cause: 'pdf-queue-full' },
      );
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
        throw new GatewayTimeoutException('Rendering the PDF took too long. Try a shorter document.');
      }
      this.log.error(`PDF renderer unreachable: ${(err as Error).message}`);
      throw new ServiceUnavailableException('The PDF renderer is unreachable. Try again shortly.');
    }

    if (res.status === 503) {
      // Gotenberg's own deadline ("did not complete within the configured maximum duration").
      throw new GatewayTimeoutException('Rendering the PDF took too long. Try a shorter document.');
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 500);
      this.log.error(`PDF renderer returned ${res.status}: ${detail}`);
      throw new BadGatewayException('The PDF renderer could not render this document.');
    }
    const pdf = Buffer.from(await res.arrayBuffer());
    if (pdf.subarray(0, 4).toString('latin1') !== '%PDF') {
      this.log.error(`PDF renderer returned a non-PDF body (${pdf.length} bytes)`);
      throw new BadGatewayException('The PDF renderer returned something that is not a PDF.');
    }
    return pdf;
  }
}
