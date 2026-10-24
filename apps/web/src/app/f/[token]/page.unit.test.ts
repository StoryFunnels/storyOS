import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Ticket #1032 — the public form page navigates with `window.location.href = …`, which the router's own guard does not cover. It must
 * only ever be handed an http(s) address, whatever the server returned. (The decision itself — which values count — is
 * `safeHttpUrl`, tested against javascript:, data:, vbscript: and the scheme-obfuscation variants in packages/schemas.)
 */
describe('the public form page navigates only to an http(s) redirect (ticket #1032)', () => {
  const src = readFileSync(join(__dirname, 'page.tsx'), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  it('never assigns the server\'s redirect_url to location unfiltered', () => {
    expect(src).not.toMatch(/location\.href\s*=\s*def\??\.redirect_url/);
    expect(src).not.toMatch(/location\.(href|assign|replace)\s*[=(]\s*def/);
  });
  it('passes it through safeHttpUrl first, and navigates to the result', () => {
    expect(src).toMatch(/const target = safeHttpUrl\(def\?\.redirect_url\)/);
    expect(src).toMatch(/window\.location\.href = target/);
  });
});
