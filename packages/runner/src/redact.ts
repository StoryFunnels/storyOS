// SPDX-License-Identifier: Apache-2.0
/**
 * Nothing secret reaches a log or the terminal (ADR-0021 section 7, point 5). The server has its own redactor; it is AGPL, so the
 * Runner carries this one.
 *
 * Two layers, because a pattern alone cannot know a secret it has never seen the shape of:
 *  - shapes: `mn_run_...` (a Runner token), `mn_pat_...` (a personal token), and `Bearer <anything>`;
 *  - exact values: the pairing code the person typed and the run credential of each claimed wake are REGISTERED the moment the
 *    Runner learns them, and replaced wherever they appear, whatever they look like.
 */

const MASK = '[redacted]';

const SHAPES: RegExp[] = [
  /mn_(?:run|pat|agt|tok)_[A-Za-z0-9_-]{6,}/g,
  /(Bearer\s+)[A-Za-z0-9._~+/=-]{6,}/gi,
  /("?(?:token|authorization|credential|secret|password)"?\s*[:=]\s*"?)[^\s",}]{6,}/gi,
];

const known = new Set<string>();

/** Remember an exact secret value. Very short values are ignored: masking "a" would mangle every line. */
export function registerSecret(value: string | null | undefined): void {
  if (typeof value !== 'string') return;
  const v = value.trim();
  if (v.length >= 4) known.add(v);
}

/** Forget a secret (a run credential is dropped from memory with its run). */
export function forgetSecret(value: string | null | undefined): void {
  if (typeof value === 'string') known.delete(value.trim());
}

export function clearSecrets(): void {
  known.clear();
}

export function redact(text: string): string {
  let out = text;
  for (const secret of known) {
    // Case-insensitive: a pairing code is typed in any case, and the log must not give it back in a different spelling.
    out = out.replace(new RegExp(escapeRegExp(secret), 'gi'), MASK);
  }
  for (const shape of SHAPES) {
    out = out.replace(shape, (_m, prefix: unknown) => (typeof prefix === 'string' ? `${prefix}${MASK}` : MASK));
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
