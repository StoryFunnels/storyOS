import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Ticket #1285 (child of #1272): Settings > Connections fidelity. Source checks, as the rest of the Settings guards are (this repo has
 * no DOM test setup); each assertion names the defect it holds shut, and the second half of every item says what must be KEPT.
 */
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');
const SETTINGS = 'app/w/[ws]/settings';

describe('item 1: one interactive element per Integrations row', () => {
  const hub = read(`${SETTINGS}/integrations/page.tsx`);

  it('no <Button> sits inside a <Link> (a button in a link is invalid HTML and two Tab stops)', () => {
    expect(hub).not.toMatch(/<Link[^>]*>\s*<button/i);
    expect(hub).not.toMatch(/<button[^>]*>\s*<Link/i);
  });

  it('the Add-row Connect/Open is a link wearing the shared button classes', () => {
    expect(hub).toMatch(/<Link[^>]*className=\{buttonVariants\(\{ size: 'sm', variant: 'secondary' \}\)\}/);
  });

  it('KEEPS: the connected rows are one link each, and the Details link stays for a state with no Connect', () => {
    expect(hub).toMatch(/<Link key=\{s\.def\.id\} href=\{providerPageHref\(ws, s\.def\.id\)\}/);
    expect(hub).toContain('Details');
    expect(hub).toContain("builtin ? 'Open' : 'Connect'");
  });
});
