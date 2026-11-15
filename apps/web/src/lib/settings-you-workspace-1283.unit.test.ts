// A west-of-UTC clock so a date made at local noon is the same calendar day everywhere the test runs.
process.env.TZ = 'America/Los_Angeles';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_REGIONAL, formatDate, friendlyDateExample } from '@/lib/format';

/**
 * Ticket #1283: Settings, You and Workspace pages against the design reference. The pages are client components on queries and
 * this repo has no DOM test setup, so the structural guards read the page source (the pattern of settings-you-data-1189). Every
 * guard here was mutated once to prove it can fail (see the PR).
 */
const SRC = fileURLToPath(new URL('..', import.meta.url));
const SETTINGS = join(SRC, 'app/w/[ws]/settings');
const read = (p: string) => readFileSync(p, 'utf8');
const page = (dir: string) => read(join(SETTINGS, dir, 'page.tsx'));

const NOON = new Date(2026, 10, 13, 12, 0); // Fri 13 Nov 2026, local noon

/** Run `fn` as a viewer whose locale is `locale`: the app asks for the viewer's own locale (undefined), so pin what undefined means. */
function asLocale<T>(locale: string, fn: () => T): T {
  const real = Date.prototype.toLocaleDateString;
  const spy = vi.spyOn(Date.prototype, 'toLocaleDateString').mockImplementation(function (this: Date, _l, o) {
    return real.call(this, locale, o);
  });
  try {
    return fn();
  } finally {
    spy.mockRestore();
  }
}

afterEach(() => vi.restoreAllMocks());

describe('item 1: the Friendly example and the "Now:" line say the same thing in the same order', () => {
  it('the example is "Today, " + the very text the Now line shows when Friendly is chosen, whichever order the locale writes', () => {
    for (const [locale, text] of [
      ['en-US', 'Nov 13'],
      ['en-GB', '13 Nov'],
    ] as const) {
      asLocale(locale, () => {
        const now = formatDate(NOON, DEFAULT_REGIONAL, { relative: false, now: NOON });
        expect(now).toBe(text);
        expect(friendlyDateExample(NOON)).toBe(`Today, ${text}`);
      });
    }
  });

  it('is today, not a fixed day: the day moves with the date it is given', () => {
    asLocale('en-GB', () => {
      expect(friendlyDateExample(new Date(2026, 0, 2, 9, 0))).toBe('Today, 2 Jan');
    });
  });

  it('the page draws the option from that function and carries no fixed example date; the other three options are kept as they were', () => {
    const src = page('preferences');
    expect(src).toContain('friendlyDateExample');
    expect(src).not.toMatch(/Today, \d/);
    expect(src).not.toMatch(/\b21 Oct\b/);
    for (const kept of ["'MM/DD/YYYY'", "'DD/MM/YYYY'", "'YYYY-MM-DD'"]) expect(src).toContain(kept);
    expect(src).toMatch(/label: `Friendly \(\$\{friendlyDateExample\(now\)\}\)`/);
  });
});

describe('item 2: two or three short options are the segmented control, as in the design', () => {
  const src = page('preferences');
  const menuLabels = [...src.matchAll(/<MenuSelect\s+label="([^"]+)"/g)].map((m) => m[1]);
  const segLabels = [...src.matchAll(/<Segmented\s+label="([^"]+)"/g)].map((m) => m[1]);

  it('Theme and Time format are segmented controls', () => {
    expect(segLabels).toEqual(['Theme', 'Time format']);
  });

  it('what must be KEPT as a menu: Date format and Week starts on, which have four options each', () => {
    expect(menuLabels).toEqual(['Date format', 'Week starts on']);
    const week = src.slice(src.indexOf('const WEEK_OPTIONS'), src.indexOf('\n];', src.indexOf('const WEEK_OPTIONS')));
    expect(week).toContain("'saturday'"); // the design leaves Saturday out; the product keeps it
    expect(week).toContain("'system'");
  });

  it('every time-format value is still offered, and the control is disabled while preferences load, as the menu was', () => {
    const time = src.slice(src.indexOf('const TIME_OPTIONS'), src.indexOf('\n];', src.indexOf('const TIME_OPTIONS')));
    for (const v of ["'system'", "'12h'", "'24h'"]) expect(time).toContain(v);
    expect(src).toMatch(/TIME_OPTIONS\.map\(\(o\) => \(\{ \.\.\.o, disabled: prefs\.isLoading \}\)\)/);
  });
});

describe('item 3: the people avatars are the design’s sizes', () => {
  it('Profile photo is 40px and Members rows are 26px, both sizes the shared Avatar offers', () => {
    const avatar = read(join(SRC, 'components/ui/avatar.tsx'));
    expect(avatar).toMatch(/40: 'h-10 w-10 text-body'/);
    expect(avatar).toMatch(/26: 'h-\[26px\] w-\[26px\] text-micro'/);
    expect(page('account')).toMatch(/<Avatar [^>]*size=\{40\}/);
    expect(page('members')).toMatch(/<Avatar [^>]*size=\{26\}/);
  });

  it('what must be KEPT: the sizes every other surface uses are still there', () => {
    const avatar = read(join(SRC, 'components/ui/avatar.tsx'));
    for (const k of ['16:', '18:', '20:', '24:', '32:', '64:']) expect(avatar).toContain(k);
  });
});

describe('item 4: one in-row danger button, red words on the neutral border', () => {
  /** The Button that opens/starts the dangerous thing, found by its visible words. */
  const trigger = (src: string, words: RegExp) => {
    const at = src.search(words);
    expect(at, `${words} not found`).toBeGreaterThan(-1);
    return src.slice(src.lastIndexOf('<Button', at), at);
  };

  it('Delete my account, Erase a person and Uninstall are all secondary with text-error', () => {
    const account = trigger(page('account'), /Delete my account…/);
    expect(account).toContain('variant="secondary"');
    expect(account).toContain('text-error');
    expect(trigger(page('members'), /aria-label=\{`\$\{label\}: choose a person`\}/)).toContain('variant="secondary"');
    expect(page('members')).toMatch(/choose a person`\}\s+className=\{danger \? 'text-error'/);
    const packs = page('packs');
    const uninstall = packs.slice(packs.lastIndexOf('<Button', packs.indexOf('row.uninstallAriaLabel')), packs.indexOf('row.uninstallAriaLabel'));
    expect(uninstall).toContain('variant="secondary"');
    expect(uninstall).toContain('text-error');
  });

  it('no Settings page puts the filled red-bordered `destructive` look on a button that only opens a dialog', () => {
    const src = page('account');
    const opener = src.slice(src.lastIndexOf('<DialogTrigger', src.indexOf('Delete my account…')), src.indexOf('Delete my account…'));
    expect(opener).not.toContain('variant="destructive"');
  });

  it('what must be KEPT: the confirm buttons inside the dialogs stay destructive', () => {
    expect(page('account')).toMatch(/variant="destructive"[\s\S]{0,500}Delete my account permanently/);
    expect(page('members')).toMatch(/variant="destructive"[\s\S]{0,300}Erase from this workspace/);
  });
});
