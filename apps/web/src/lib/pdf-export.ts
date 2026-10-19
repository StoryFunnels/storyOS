import { fallbackMessageForStatus } from '@/lib/http-error';

/**
 * #876 — the web half of server-rendered PDF export (#262).
 *
 * The server's contract (apps/docs api/conventions.md, "Exporting a document to PDF"): ask
 * `GET /capabilities` first and gate on `pdf_export.available` — reachability, not "a variable
 * is set" — then `GET .../documents/:doc/export/pdf`. Every refusal carries a stable
 * `error.code`; this file turns each into one sentence a person can act on.
 */

export interface PdfExportStatus {
  configured: boolean;
  reachable: boolean | null;
  available: boolean;
  checked_at: string | null;
}

/** What the control says while it is unavailable. Names the cause only when the API does. */
export function unavailableReason(status: PdfExportStatus | undefined): string {
  if (status?.configured && status.reachable === false) {
    return 'PDF export is set up on this server, but the renderer is not answering right now. Try again in a minute.';
  }
  return 'PDF export is not set up on this server. An administrator has to run the PDF renderer first.';
}

interface ErrorEnvelope {
  error?: { code?: string; message?: string; meta?: Record<string, unknown> };
}

const n = (v: unknown): string | null => (typeof v === 'number' ? v.toLocaleString('en-US') : null);

/**
 * One human sentence per refusal. Never the response body: a proxy's HTML page must not reach the
 * screen, and a 413 without its figure is not actionable (#876 AC3).
 */
export function pdfExportErrorMessage(status: number, body: unknown): string {
  const err = (body as ErrorEnvelope | undefined)?.error;
  const meta = err?.meta ?? {};
  switch (err?.code) {
    case 'pdf_export_not_configured':
      return 'PDF export is not set up on this server. An administrator has to run the PDF renderer first.';
    case 'pdf_export_busy': {
      const s = n(meta.retry_after_seconds);
      return `Another PDF is being made right now. Try again in ${s ?? 'a few'} seconds.`;
    }
    case 'pdf_render_timeout': {
      const ms = typeof meta.timeout_ms === 'number' ? Math.round(meta.timeout_ms / 1000) : null;
      return `Making the PDF took too long${ms ? ` (over ${ms} seconds)` : ''}. Try a shorter document.`;
    }
    case 'pdf_renderer_unreachable':
      return 'The PDF renderer is not answering. Try again in a minute.';
    case 'pdf_render_failed':
      return 'The PDF renderer could not render this document.';
    case 'document_too_large': {
      const limit = n(meta.limit);
      const measured = n(meta.measured);
      const unit = typeof meta.unit === 'string' ? meta.unit : 'characters';
      if (limit && measured) {
        return `This document is too large to export as a PDF: ${measured} ${unit}, and the limit is ${limit}. Split it or trim it.`;
      }
      if (limit) return `This document is too large to export as a PDF. The limit is ${limit} ${unit}.`;
      break;
    }
  }
  // A JSON envelope from the API we have no sentence for: its own message beats a generic one.
  if (err?.message) return err.message;
  return fallbackMessageForStatus(status);
}

/** The filename the server sent, else a slug of the title. */
export function pdfFilename(contentDisposition: string | null, title: string): string {
  const star = /filename\*=UTF-8''([^;]+)/i.exec(contentDisposition ?? '');
  if (star) {
    try {
      return decodeURIComponent(star[1]!.trim());
    } catch {
      /* fall through */
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(contentDisposition ?? '');
  if (plain) return plain[1]!.trim();
  const slug =
    title
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'document';
  return `${slug}.pdf`;
}
