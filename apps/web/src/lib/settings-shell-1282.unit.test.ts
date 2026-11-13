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

/** Whether `needle` appears in the opening tag that starts at or just before it (the tag carries a size). */
function openingTag(src: string, anchor: string): string {
  const at = src.indexOf(anchor);
  expect(at, `anchor ${anchor}`).toBeGreaterThan(-1);
  const start = Math.max(src.lastIndexOf('<Button', at), src.lastIndexOf('<a', at), src.lastIndexOf('buttonVariants', at));
  return src.slice(start, src.indexOf('>', at));
}

describe('one page title (#1282, item 6)', () => {
  it('a Settings page title is drawn by SettingsPageHeader, or by an h1 with exactly its classes', () => {
    const TITLE = 'text-lg font-bold leading-[1.3] tracking-[-0.01em] text-ink';
    const sources = [...pages, ...files(join(SRC, 'components/settings'))].filter((f) => !f.endsWith('settings-chrome.tsx'));
    for (const f of sources) {
      for (const m of read(f).matchAll(/<h1\b[^>]*className="([^"]*)"/g)) {
        expect(m[1], `${rel(f)} draws its own page title`).toBe(TITLE);
      }
    }
  });

  it('the pages that drew their own (API tokens, Webhooks, Runners) use the shared header, with their action in it', () => {
    for (const f of ['api/page.tsx', 'webhooks/page.tsx', 'runners/page.tsx']) {
      const src = read(join(SETTINGS, f));
      expect(src, f).toMatch(/<SettingsPageHeader[\s\S]*?action=/);
      expect(src, f).not.toContain('<h1');
    }
  });

  it('the header lets a long lead share the line with its action instead of pushing the action down', () => {
    expect(read(join(SRC, 'components/settings/settings-chrome.tsx'))).toContain('min-w-0 flex-1 basis-72');
  });
});

describe('one button size on a Settings page (#1282, item 7)', () => {
  it('page-level actions are the small button (28px), not the 36px default', () => {
    const cases: Array<[string, string]> = [
      ['account/page.tsx', 'disabled={save.isPending || !dirty}'],
      ['account/page.tsx', 'disabled={change.isPending'],
      ['general/page.tsx', 'onClick={save}'],
      ['general/page.tsx', 'onClick={saveBranding}'],
      ['packs/page.tsx', "variant: 'secondary'"],
      ['export/page.tsx', "buttonVariants({ size: 'sm' })"],
    ];
    for (const [f, anchor] of cases) {
      const src = read(join(SETTINGS, f));
      const at = src.indexOf(anchor);
      expect(at, `${f}: ${anchor}`).toBeGreaterThan(-1);
      const tag = src.slice(Math.max(0, at - 200), at + 120);
      expect(tag, `${f}: ${anchor}`).toMatch(/size[=:] ?\{? ?['"]sm['"]/);
    }
  });

  it('the Export link wears the shared button classes merged, not a restated 36px copy', () => {
    const src = read(join(SETTINGS, 'export/page.tsx'));
    expect(src).not.toContain('h-9');
    expect(src).toContain('cn(buttonVariants');
  });

  it('a link that looks like a button merges its classes (cva alone leaves 14px and 13px both on it)', () => {
    expect(read(join(SETTINGS, 'packs/page.tsx'))).toContain('cn(buttonVariants(');
  });
});

describe('one Advanced disclosure, always last (#1282, item 8)', () => {
  it('no Settings page draws a bare <details>: every disclosure is AdvancedSection', () => {
    for (const f of pages) expect(read(f), rel(f)).not.toMatch(/<details\b/);
  });

  it('the Advanced section is the last thing a page draws', () => {
    for (const f of ['general', 'members', 'packs', 'account', 'api', 'webhooks', 'connect-ai']) {
      const src = read(join(SETTINGS, f, 'page.tsx'));
      const last = src.lastIndexOf('</AdvancedSection>');
      expect(last, f).toBeGreaterThan(-1);
      const tail = src.slice(last + '</AdvancedSection>'.length);
      const rest = tail.slice(0, tail.indexOf('\n}\n'));
      // What may follow: closing tags, and a dialog, possibly behind a condition (it draws nothing until opened, so it is not "on the page").
      const drawn = rest.replace(/<\w*Dialog\b[\s\S]*?\/>/g, '').replace(/\w+ &&/g, '').replace(/<\/(div|SettingsPageBody)>|<\/>|<>|[\s);(}{]/g, '');
      expect(drawn, `${f}: something is drawn after Advanced`).toBe('');
    }
  });

  it('the retired titles are gone: "Advanced / Developer" above the list, "Advanced — for developers"', () => {
    for (const f of ['api', 'webhooks']) {
      const src = read(join(SETTINGS, f, 'page.tsx'));
      expect(src).not.toContain('Advanced / Developer');
      expect(src).not.toContain('Advanced — for developers');
      expect(src).toContain('<AdvancedSection title="Advanced"');
    }
  });

  it('what the old boxes said is still said: the signing header and the token header both stay', () => {
    expect(read(join(SETTINGS, 'webhooks/page.tsx'))).toContain('X-StoryOS-Signature');
    expect(read(join(SETTINGS, 'api/page.tsx'))).toContain('Authorization: Bearer mn_pat_');
    expect(read(join(SETTINGS, 'connect-ai/page.tsx'))).toContain('Manage API tokens');
  });
});
