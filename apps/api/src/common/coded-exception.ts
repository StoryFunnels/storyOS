import { HttpException } from '@nestjs/common';

/**
 * An HttpException that carries what a client needs to act on it, as FIELDS:
 *
 *  - `code`  — a specific, stable machine-readable code (`pdf_export_busy`) in place
 *    of the status-derived default (`error`). A client that must treat "busy" and
 *    "not configured" differently — both are a 503 — must not have to parse prose.
 *  - `meta`  — structured numbers and flags (`{ limit, measured, unit }`). The
 *    envelope's `details` is an array of `{ path, message }` strings; a figure that
 *    only exists inside a sentence cannot be shown, compared or localised.
 *
 * `meta.retry_after_seconds` additionally becomes a `Retry-After` header — the same
 * convention the 429 already follows (docs/architecture/api-conventions.md).
 *
 * Read by AllExceptionsFilter; an exception without these behaves exactly as before.
 */
export function codedException(
  status: number,
  code: string,
  message: string,
  meta?: Record<string, unknown>,
): HttpException {
  return new HttpException({ code, message, ...(meta ? { meta } : {}) }, status);
}
