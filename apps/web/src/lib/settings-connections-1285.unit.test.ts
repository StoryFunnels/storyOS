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

describe('item 3: API tokens and Webhooks use the shared Settings chrome', () => {
  for (const [name, rel] of [
    ['API tokens', `${SETTINGS}/api/page.tsx`],
    ['Webhooks', `${SETTINGS}/webhooks/page.tsx`],
  ] as const) {
    const src = read(rel);
    it(`${name}: shared header, a SettingsBox list, and the Advanced disclosure LAST`, () => {
      expect(src).toContain('<SettingsPageHeader');
      expect(src).toContain('<SettingsBox');
      expect(src).toContain('<AdvancedSection');
      // The hand-drawn old shapes: an h1 with its own button row, a bare <details>, an `overflow-hidden` list.
      expect(src).not.toMatch(/<h1 className="text-lg font-semibold/);
      expect(src).not.toContain('<details');
      // Advanced is last in the body: nothing but the closing tags (and, for tokens, the one-line note) follows it.
      const afterAdvanced = src.slice(src.indexOf('</AdvancedSection>'));
      expect(afterAdvanced.slice(0, afterAdvanced.indexOf('</SettingsPageBody>'))).not.toContain('<SettingsBox');
    });
  }

  it('API tokens: the lead is one line, and the other-workspaces note/control is KEPT', () => {
    const src = read(`${SETTINGS}/api/page.tsx`);
    expect(src).toContain('lead="Personal tokens for scripts');
    expect(src).toContain('Tokens you made in other workspaces are listed there, not here.');
    expect(src).toContain('Show tokens from my other workspaces');
    expect(src).toContain('confirmRevokeToken');
  });

  it('Webhooks: the empty state points at the simpler path, and every old control and explanation is KEPT', () => {
    const src = read(`${SETTINGS}/webhooks/page.tsx`);
    expect(src).toContain('Send webhook');
    expect(src).toContain('usually simpler');
    for (const kept of ['Add webhook', 'Deliveries', 'confirmToggleWebhook', 'Delete this webhook?', 'X-StoryOS-Signature', 'Full signing docs', 'n8n', 'retried automatically', 'webhook-last-error']) {
      expect(src, kept).toContain(kept);
    }
  });

  it('the shared header lets a long lead wrap in its own column, so the action stays on the title line', () => {
    const chrome = read('components/settings/settings-chrome.tsx');
    expect(chrome).toMatch(/min-w-0 flex-1 basis-\[min\(100%,24rem\)\]/);
  });
});
