import { BadRequestException, HttpException, NotFoundException } from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { codedException } from '../src/common/coded-exception';

/**
 * #885 — the one error envelope now lets a thrower name a SPECIFIC code and attach
 * structured `meta`, and turns `meta.retry_after_seconds` into a `Retry-After` header.
 *
 * Found while building it: #1050's busy-503 attached `retry_after_seconds` to the
 * exception body and the filter silently dropped it — the "retry hint" reached the
 * client as prose only, and 503 / 504 / 413 all arrived with the same code `error`.
 * The first group below is what makes that impossible to ship again; the last group
 * is the part that must NOT change: every error that carries none of this.
 */
function run(exception: unknown) {
  const sent: { status?: number; body?: unknown; headers: Record<string, string> } = { headers: {} };
  const reply = {
    status(n: number) {
      sent.status = n;
      return this;
    },
    header(k: string, v: string) {
      sent.headers[k] = v;
      return this;
    },
    send(b: unknown) {
      sent.body = b;
      return this;
    },
  };
  const host = {
    switchToHttp: () => ({ getResponse: () => reply, getRequest: () => ({ id: 'req-1' }) }),
  } as unknown as ArgumentsHost;
  new AllExceptionsFilter().catch(exception, host);
  return sent as { status: number; body: { error: Record<string, unknown> }; headers: Record<string, string> };
}

describe('a coded exception reaches the client with its code and its figures', () => {
  it('uses the specific code instead of the generic status-derived one', () => {
    const r = run(codedException(503, 'pdf_export_busy', 'busy'));
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('pdf_export_busy');
    expect(r.body.error.message).toBe('busy');
  });

  it('carries meta as structured fields, numbers staying numbers', () => {
    const r = run(codedException(413, 'document_too_large', 'too big', { limit: 6_000_000, measured: 7_500_000, unit: 'characters' }));
    expect(r.body.error.meta).toEqual({ limit: 6_000_000, measured: 7_500_000, unit: 'characters' });
    expect(typeof (r.body.error.meta as { limit: unknown }).limit).toBe('number');
  });

  it('sends meta.retry_after_seconds as a Retry-After header too', () => {
    const r = run(codedException(503, 'pdf_export_busy', 'busy', { retry_after_seconds: 10 }));
    expect(r.headers['retry-after']).toBe('10');
    expect((r.body.error.meta as { retry_after_seconds: number }).retry_after_seconds).toBe(10);
  });

  it('rounds a fractional retry interval UP, so a client never retries early', () => {
    expect(run(codedException(503, 'pdf_export_busy', 'busy', { retry_after_seconds: 2.2 })).headers['retry-after']).toBe('3');
  });

  it('sets no Retry-After for a zero, negative or non-numeric interval', () => {
    for (const bad of [0, -5, 'soon', null]) {
      const r = run(codedException(503, 'pdf_export_busy', 'busy', { retry_after_seconds: bad }));
      expect(r.headers['retry-after'], String(bad)).toBeUndefined();
    }
  });
});

describe('malformed input is ignored, never half-honoured', () => {
  it('a code that is not a stable machine code falls back to the status default', () => {
    for (const code of ['Bad Code!', 'X', '', 'UPPER_CASE', 5, null]) {
      const r = run(new HttpException({ code, message: 'm' }, 503));
      expect(r.body.error.code, String(code)).toBe('error');
    }
  });

  it('meta that is not a plain object is dropped', () => {
    for (const meta of [[1, 2], 'str', 7, null]) {
      const r = run(new HttpException({ message: 'm', meta }, 503));
      expect(r.body.error, JSON.stringify(meta)).not.toHaveProperty('meta');
    }
  });
});

describe('MUST KEEP WORKING — an error with none of this is exactly the old envelope', () => {
  it('a plain NotFoundException is still not_found with no meta and no Retry-After', () => {
    const r = run(new NotFoundException('Document not found'));
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: { code: 'not_found', message: 'Document not found', request_id: 'req-1' } });
    expect(r.headers).toEqual({});
  });

  it('a BadRequestException keeps bad_request', () => {
    expect(run(new BadRequestException('nope')).body.error.code).toBe('bad_request');
  });

  it('details still pass through untouched', () => {
    const r = run(new HttpException({ message: 'm', details: [{ path: 'a', message: 'b' }] }, 422));
    expect(r.body.error.details).toEqual([{ path: 'a', message: 'b' }]);
    expect(r.body.error.code).toBe('validation_failed');
  });

  it('an unknown error is still a bare 500 that does not echo its message', () => {
    const r = run(new Error('secret internal detail'));
    expect(r.status).toBe(500);
    expect(r.body.error.code).toBe('internal_error');
    expect(JSON.stringify(r.body)).not.toContain('secret internal detail');
  });
});
