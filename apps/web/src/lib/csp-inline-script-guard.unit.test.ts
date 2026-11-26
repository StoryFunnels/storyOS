import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Ticket #1238: the enforced CSP runs scripts only when they carry the request's nonce, and Next stamps that nonce on every script
 * IT emits (framework chunks, `next/script`). Anything a developer writes by hand does not get one: a raw `<script>` element, an
 * inline `on…=` handler, or `eval`/`new Function` would be blocked in production, and nothing fails to compile. This pins the set of
 * places the app injects script, derived from the source tree, so a new one is a conscious change here rather than a blank page
 * (or a new `'unsafe-inline'`) found after deploy.
 */
const SRC = join(__dirname, '..');
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/.*$/gm, '$1');
const sources = walk(SRC)
  .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.(unit\.)?test\.tsx?$/.test(f))
  .map((f) => ({ file: relative(SRC, f), text: strip(readFileSync(f, 'utf8')) }));
const hits = (re: RegExp) => sources.filter((s) => re.test(s.text)).map((s) => s.file);

describe('#1238 scripts the app injects by hand', () => {
  it('has no raw <script> element: the one inline script goes through next/script, which Next nonces', () => {
    expect(hits(/<script[\s>]/)).toEqual([]);
    expect(hits(/from 'next\/script'/)).toEqual(['app/layout.tsx']);
  });

  it('has no inline event-handler attribute in markup (React props are fine; string-built HTML is not)', () => {
    expect(hits(/<[a-z]+[^>]*\son(click|error|load|mouseover|focus|submit)=["']/i)).toEqual([]);
  });

  it('has no eval or new Function in app code: the enforced policy has no unsafe-eval', () => {
    expect(hits(/(^|[^.\w])eval\(|new Function\(/)).toEqual([]);
  });

  it('every dangerouslySetInnerHTML is one of the known, reviewed sites', () => {
    expect(hits(/dangerouslySetInnerHTML/).sort()).toEqual(['app/layout.tsx', 'components/quill/quill.tsx']);
  });
});
