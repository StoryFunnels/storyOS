import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Ticket #1290 item 2 — the Business Packs header follows the design reference: a 22px/700 page title with the tightened tracking
 * (the same title Agents and Runners already wear) and "Submit a pack" as a bordered secondary button, not a bare muted link.
 * Source-level on purpose: the page is all hooks and queries, and what is pinned here is two class lists.
 */
const src = readFileSync(fileURLToPath(new URL('./page.tsx', import.meta.url)), 'utf8');
const h1 = src.match(/<h1 className="([^"]+)"/)?.[1] ?? '';

describe('Business Packs page header (#1290)', () => {
  it('the title is 22px / 700 with -0.02em tracking', () => {
    expect(h1).toContain('text-[22px]');
    expect(h1).toContain('font-bold');
    expect(h1).toContain('tracking-[-0.02em]');
    expect(h1).not.toContain('font-semibold');
  });

  it('keeps the package icon beside the title and the ink colour', () => {
    expect(h1).toContain('text-ink');
    expect(src).toMatch(/<h1[^>]*>\s*<Package [^>]*\/> Business Packs/);
  });

  it('Submit a pack wears the shared secondary button classes, and is still only offered to people who can install', () => {
    expect(src).toMatch(/href=\{`\/w\/\$\{ws\}\/packs\/submit`\}\s+className=\{cn\(buttonVariants\(\{ variant: 'secondary', size: 'sm' \}\)\)\}/);
    expect(src).toMatch(/\{canInstall && \(\s*<Link\s+href=\{`\/w\/\$\{ws\}\/packs\/submit`\}/);
  });
});
