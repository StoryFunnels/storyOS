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

describe('item 4: provider pages share the rest of Settings\' type scale', () => {
  const providerPages = ['github', 'linear', 'slack', 'shopify', 'youtube', 'google-calendar', 'delegate-agent'].map((p) => [p, read(`${SETTINGS}/integrations/${p}/page.tsx`)] as const);

  it('every <Input> on a provider page is the 32px / 13px size (it was the 36px / 14px default)', () => {
    for (const [name, src] of providerPages) {
      for (const m of src.matchAll(/<Input\b([\s\S]*?)(\/>|>)/g)) expect(m[1], `${name}: ${m[0].slice(0, 60)}`).toMatch(/size="sm"/);
    }
  });

  it('no provider page draws its own 14px/600 section heading (the box title is the heading)', () => {
    for (const [name, src] of providerPages) expect(src, name).not.toMatch(/<h2 className="[^"]*text-prose font-semibold/);
  });

  it('How setup works is a shared SettingsBox of rows: no uppercase label, no nested bordered cards', () => {
    const guide = read('components/integration-setup-guide.tsx');
    expect(guide).toContain('<SettingsBox title={title}');
    expect(guide).not.toMatch(/uppercase|tracking-wide/);
    expect(guide).not.toMatch(/rounded-\[var\(--radius-control\)\] border p-3/);
  });

  it('KEEPS: the three states of a step (done, next, upcoming) and every step label still render', () => {
    const guide = read('components/integration-setup-guide.tsx');
    for (const k of ["state === 'current'", "state === 'complete'", "state === 'upcoming'", 'step.label', 'step.description', 'Next']) expect(guide, k).toContain(k);
  });
});

describe('item 6: the GitHub page speaks to a user, and review settings wait for a connection', () => {
  const gh = read(`${SETTINGS}/integrations/github/page.tsx`);

  it('no ticket number, no placeholder row, no "Turns off the … API" in the copy', () => {
    // Copy only: comments may name tickets and say why the GitLab row is gone.
    const jsxCopy = gh.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(jsxCopy).not.toMatch(/\(#\d+\)/);
    expect(jsxCopy).not.toMatch(/GitLab|Planned, not built|Coming soon/);
    expect(gh).not.toMatch(/and its API/);
  });

  it('the review settings render only once GitHub is connected, inside the Advanced disclosure', () => {
    expect(gh).toMatch(/\{hasCredential && <ReviewSettingsSection ws=\{ws\} \/>\}/);
    expect(gh).toContain('<AdvancedSection title="Code and reviews"');
    expect(gh).not.toMatch(/uppercase tracking-wider/);
  });

  it('KEEPS: all four switches and all three selects of the review settings', () => {
    for (const label of ['Enable Code & reviews', 'Auto-convert draft PRs', 'Notify on comments and mentions', 'Notify on review requests']) expect(gh, label).toContain(`aria-label="${label}"`);
    for (const opt of ['Squash and merge', 'Match system', 'Monospace (ligatures)']) expect(gh, opt).toContain(opt);
  });
});
