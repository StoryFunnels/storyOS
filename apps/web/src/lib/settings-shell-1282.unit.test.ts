import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SettingsRefusal } from '@/components/settings/settings-chrome';
import { AdminsOnlyNotice } from '@/components/settings/admins-only';
import { SETTINGS_BACK_ROW_CLASS, settingsRowWeightClass } from '@/lib/settings-menu';

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
  it('page-level actions are the one button size: no page restates a height, or asks for another size (ticket #1282 ruling: one size)', () => {
    const cases: Array<[string, string]> = [
      ['account/page.tsx', 'disabled={save.isPending || !dirty}'],
      ['account/page.tsx', 'disabled={change.isPending'],
      ['general/page.tsx', 'onClick={save}'],
      ['general/page.tsx', 'onClick={saveBranding}'],
      ['packs/page.tsx', "variant: 'secondary'"],
      ['export/page.tsx', 'buttonVariants()'],
    ];
    for (const [f, anchor] of cases) {
      const src = read(join(SETTINGS, f));
      const at = src.indexOf(anchor);
      expect(at, `${f}: ${anchor}`).toBeGreaterThan(-1);
      const tag = src.slice(Math.max(0, at - 200), at + 120);
      expect(tag, `${f}: ${anchor}`).not.toMatch(/size[=:] ?\{? ?['"](default|lg)['"]|\bh-(7|8|9|10|11)\b/);
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
      // Ticket #1285: these two pages retitle the one disclosure as the prototype does ("How to use a token", "How webhooks work");
      // it is still the shared AdvancedSection, still last.
      expect(src).toMatch(/<AdvancedSection title="(Advanced|How to use a token|How webhooks work)"/);
    }
  });

  it('what the old boxes said is still said: the signing header and the token header both stay', () => {
    expect(read(join(SETTINGS, 'webhooks/page.tsx'))).toContain('X-StoryOS-Signature');
    expect(read(join(SETTINGS, 'api/page.tsx'))).toContain('Authorization: Bearer mn_pat_');
    expect(read(join(SETTINGS, 'connect-ai/page.tsx'))).toContain('Manage API tokens');
  });
});

describe('the Settings menu (#1282, items 1 and 3)', () => {
  it('the current page is 650 and every other row stays 400', () => {
    expect(settingsRowWeightClass(true)).toBe('font-[650]');
    expect(settingsRowWeightClass(false)).toBe('font-normal');
  });

  it('the menu rows take that weight, and the Back row is the 28px target (34px on a phone)', () => {
    const src = read(join(SRC, 'components/settings/settings-sidebar-menu.tsx'));
    expect(src).toContain('settingsRowWeightClass(active)');
    expect(src).toContain('className={SETTINGS_BACK_ROW_CLASS}');
    expect(SETTINGS_BACK_ROW_CLASS).toContain('h-7');
    expect(SETTINGS_BACK_ROW_CLASS).toContain('max-md:h-[34px]');
  });

  it('the row fill is still the sidebar row\u2019s own (this adds a weight, it does not restate the active background)', () => {
    const src = read(join(SRC, 'components/settings/settings-sidebar-menu.tsx'));
    expect(src).not.toMatch(/bg-active/);
    expect(src).toContain('<SidebarRow depth={0} active={active}>');
  });
});

describe('one segmented control (#1282, item 10)', () => {
  it('Slack\u2019s method chooser is the same drawn control as Preferences\u2019 Theme: no solid variant, no larger size, no faded hint text', () => {
    const slack = read(join(SETTINGS, 'integrations/slack/page.tsx'));
    const tag = slack.slice(slack.indexOf('<Segmented'), slack.indexOf('/>', slack.indexOf('<Segmented')));
    expect(tag).not.toContain('variant=');
    expect(tag).not.toContain('size=');
    expect(slack).not.toContain('opacity-75');
  });

  it('the choices it offers are unchanged', () => {
    const slack = read(join(SETTINGS, 'integrations/slack/page.tsx'));
    expect(slack).toContain('(recommended)');
    expect(slack).toContain('(simpler)');
  });
});

describe('Settings home is two columns (#1282, item 5; Otto 2026-11-13)', () => {
  const home = read(join(SETTINGS, 'page.tsx'));
  it('draws two columns from a tablet width up, one on a phone, and not an auto-fill that returns three', () => {
    expect(home).toMatch(/data-testid="settings-home-cards"/);
    expect(home).toContain('grid-cols-1');
    expect(home).toContain('min-[520px]:grid-cols-2');
    expect(home).not.toMatch(/auto-fill|grid-cols-3|minmax\(210px/);
  });

  it('keeps every card: the grid wraps the same cards, it does not drop one to fit', () => {
    expect(home).toContain('data-testid="settings-home-cards"');
    expect(home).toMatch(/\.map\(/);
  });
});
