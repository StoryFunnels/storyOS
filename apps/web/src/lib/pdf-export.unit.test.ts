import { describe, expect, it } from 'vitest';
import { pdfExportErrorMessage, pdfFilename, unavailableReason } from './pdf-export';

const env = (code: string, meta?: Record<string, unknown>, message = 'server prose') => ({
  error: { code, message, ...(meta ? { meta } : {}) },
});

describe('pdfExportErrorMessage (#876 AC3)', () => {
  it('names the limit AND the measured size in the 413', () => {
    const m = pdfExportErrorMessage(413, env('document_too_large', { limit: 400000, measured: 512345, unit: 'characters' }));
    expect(m).toContain('512,345 characters');
    expect(m).toContain('400,000');
  });
  it('still names the limit when only the limit is known', () => {
    expect(pdfExportErrorMessage(413, env('document_too_large', { limit: 400000 }))).toContain('400,000');
  });
  it('gives the retry hint on busy', () => {
    expect(pdfExportErrorMessage(503, env('pdf_export_busy', { retry_after_seconds: 10 }))).toContain('10 seconds');
  });
  it('tells busy, not-configured and unreachable apart although all are 503', () => {
    const a = pdfExportErrorMessage(503, env('pdf_export_busy'));
    const b = pdfExportErrorMessage(503, env('pdf_export_not_configured'));
    const c = pdfExportErrorMessage(503, env('pdf_renderer_unreachable'));
    expect(new Set([a, b, c]).size).toBe(3);
  });
  it('states the timeout in seconds on 504', () => {
    expect(pdfExportErrorMessage(504, env('pdf_render_timeout', { timeout_ms: 30000 }))).toContain('30 seconds');
  });
  it('falls back to the API message for an unknown code, then to a fixed sentence — never a body', () => {
    expect(pdfExportErrorMessage(500, env('weird'))).toBe('server prose');
    expect(pdfExportErrorMessage(502, undefined)).not.toMatch(/<|html/i);
  });
});

describe('unavailableReason', () => {
  it('distinguishes unreachable from not configured', () => {
    const off = unavailableReason({ configured: false, reachable: null, available: false, checked_at: null });
    const down = unavailableReason({ configured: true, reachable: false, available: false, checked_at: 'x' });
    expect(off).not.toBe(down);
    expect(down).toContain('not answering');
  });
});

describe('pdfFilename', () => {
  it('prefers the server filename*, then filename, then a title slug', () => {
    expect(pdfFilename("attachment; filename*=UTF-8''Q3%20brief.pdf", 'x')).toBe('Q3 brief.pdf');
    expect(pdfFilename('attachment; filename="a.pdf"', 'x')).toBe('a.pdf');
    expect(pdfFilename(null, 'My Spec!')).toBe('my-spec.pdf');
    expect(pdfFilename(null, '')).toBe('document.pdf');
  });
});
