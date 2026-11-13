import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SettingsRefusal } from '@/components/settings/settings-chrome';
import { AdminsOnlyNotice } from '@/components/settings/admins-only';

/**
 * Ticket #1282 — Settings shell fidelity. The shared patterns every Settings page draws (title, refusal, button size, Advanced) are
 * each checked from the source tree, so a page added later that draws its own copy fails here rather than drifting.
 */
const SRC = fileURLToPath(new URL('..', import.meta.url));
const SETTINGS = join(SRC, 'app/w/[ws]/settings');
const read = (p: string) => readFileSync(p, 'utf8');
const rel = (p: string) => relative(SRC, p);
function files(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const f = join(dir, n);
    if (statSync(f).isDirectory()) files(f, out);
    else if (/\.tsx$/.test(n)) out.push(f);
  }
  return out;
}
const pages = files(SETTINGS);

describe('the refusal is one pattern (#1282, item 12)', () => {
  it('draws the page title, then a dashed box holding a lock and the caller’s words', () => {
    const html = renderToStaticMarkup(createElement(SettingsRefusal, { title: 'Billing', children: 'Ask an admin.' }));
    expect(html).toContain('<h1');
    expect(html).toContain('>Billing</h1>');
    expect(html).toContain('border-dashed');
    expect(html).toMatch(/<svg[^>]*lucide-lock/);
    expect(html).toContain('Ask an admin.');
  });

  it('the admins-only notice is that box, naming the role and keeping its copy', () => {
    const html = renderToStaticMarkup(createElement(AdminsOnlyNotice, { title: 'Webhooks', role: 'member' }));
    expect(html).toContain('data-testid="admins-only"');
    expect(html).toContain('border-dashed');
    expect(html).toContain('Webhooks is for workspace admins. You are a member here');
  });

  it('no Settings page draws its own refusal heading: they all go through SettingsRefusal', () => {
    for (const [file, title] of [
      ['api/page.tsx', 'guests-cannot'],
      ['runners/page.tsx', 'runners-guest'],
    ] as const) {
      const src = read(join(SETTINGS, file));
      expect(src, file).toMatch(new RegExp(`<SettingsRefusal[^>]*testId="${title}"`));
    }
    for (const f of ['audit-log/page.tsx', 'trash/page.tsx', 'agent-rules/page.tsx', 'connect-ai/page.tsx']) {
      expect(read(join(SETTINGS, f)), f).toContain('<SettingsRefusal');
    }
  });
});
