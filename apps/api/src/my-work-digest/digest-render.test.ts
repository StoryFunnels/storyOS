import { describe, expect, it } from 'vitest';
import { DIGEST_ROWS_PER_SECTION, renderDigest, type DigestInput, type DigestRow } from './digest-render';
import { digestSlot } from './digest-schedule';
import { DEFAULT_MY_WORK_EMAIL } from '../users/preferences.constants';

const row = (i: number, extra: Partial<DigestRow> = {}): DigestRow => ({ title: `Task ${i}`, url: `https://app.test/r/${i}`, meta: `Issues · StoryOS · #${i}`, ...extra });
const base: Omit<DigestInput, 'sections'> = {
  workspaceName: 'JCM Agency',
  dateLabel: 'Tue 10 Nov',
  recipientEmail: 'me@example.com',
  cadenceText: 'every weekday (Mon–Fri) at 08:00',
  myWorkUrl: 'https://app.test/w/1/me',
  customizeUrl: 'https://app.test/w/1/settings/notifications',
  stopUrl: 'https://api.test/unsub?token=t',
};

describe('#1251 renderDigest', () => {
  it('returns null (so nothing is sent) when every section is empty', () => {
    expect(renderDigest({ ...base, sections: [] })).toBeNull();
    expect(renderDigest({ ...base, sections: [{ key: 'waiting', total: 0, rows: [] }, { key: 'assigned', total: 0, rows: [] }] })).toBeNull();
  });

  it('draws sections in the approved order, drops empty ones, and counts from the exact total, not the rows', () => {
    const out = renderDigest({
      ...base,
      sections: [
        { key: 'assigned_by_me', total: 3, rows: [row(1), row(2), row(3)] },
        { key: 'waiting', total: 4, rows: [row(4, { chip: { label: 'Approval', tone: 'neutral' } })] },
        { key: 'assigned', total: 143, rows: Array.from({ length: 40 }, (_, i) => row(100 + i, { chip: { label: 'In Progress', tone: 'progress' } })) },
      ],
    })!;
    expect(out.subject).toBe('Your work in JCM Agency: 4 waiting, 143 open');
    const at = (s: string) => out.html.indexOf(s);
    expect(at('Waiting on you')).toBeGreaterThan(-1);
    expect(at('Waiting on you')).toBeLessThan(at('Assigned to you'));
    expect(at('Assigned to you')).toBeLessThan(at('You assigned to others'));
    expect(out.html.match(/Task 1\d\d/g)!.length, 'capped at 15 rows').toBe(DIGEST_ROWS_PER_SECTION);
    expect(out.html).toContain('and 128 more');
    expect(out.html).toContain('Stop these emails');
    expect(out.html).toContain('Customize these emails');
    expect(out.html).toContain('<table role="presentation"');
    expect(out.text).toContain('and 128 more');
  });

  it('escapes record titles and names: a title cannot inject markup', () => {
    const out = renderDigest({ ...base, workspaceName: 'A <b>&</b>', sections: [{ key: 'assigned', total: 1, rows: [row(1, { title: '<script>alert(1)</script> & "x"' })] }] })!;
    expect(out.html).not.toContain('<script>');
    expect(out.html).toContain('&lt;script&gt;');
    expect(out.html).not.toContain('<b>&</b>');
  });

  it('a section with exactly 15 rows has no "and N more"', () => {
    const out = renderDigest({ ...base, sections: [{ key: 'assigned', total: 15, rows: Array.from({ length: 15 }, (_, i) => row(i)) }] })!;
    expect(out.html).not.toContain('more &middot;');
  });
});

describe('#1251 dark mode', () => {
  const out = renderDigest({
    ...base,
    sections: [
      { key: 'waiting', total: 2, rows: [row(1, { chip: { label: 'Approval', tone: 'neutral' } })] },
      { key: 'assigned', total: 20, rows: [row(2, { chip: { label: 'In Progress', tone: 'progress' } }), row(3, { chip: { label: 'Blocked', tone: 'attention' } }), row(4)] },
      { key: 'assigned_by_me', total: 1, rows: [row(5)] },
    ],
  })!;
  const css = out.html.match(/<style>([\s\S]*?)<\/style>/)![1]!;

  it('declares both schemes and carries a prefers-color-scheme dark block with each of Dara\'s four values', () => {
    expect(out.html).toContain('<meta name="color-scheme" content="light dark">');
    expect(out.html).toContain('<meta name="supported-color-schemes" content="light dark">');
    expect(css).toContain('@media (prefers-color-scheme: dark)');
    const dark = css.slice(css.indexOf('@media (prefers-color-scheme: dark)'));
    for (const v of ['#0a0d12', '#f3efe7', '#9a9488', '#a9b9e6']) expect(dark, v).toContain(v);
    expect(dark.match(/!important/g)!.length, 'inline styles win without !important').toBeGreaterThan(10);
  });

  it('keeps the light colours inline as the default', () => {
    expect(out.html).toContain('style="margin:0;padding:0;background:#f4efe5');
    expect(out.html).toContain('color:#0f1729');
  });

  it('every element with an inline colour, background or border colour has a d-* class, and that class is defined in the dark block', () => {
    const defined = new Set([...css.matchAll(/\.(d-[a-z-]+)\{/g)].map((m) => m[1]));
    const tags = [...out.html.matchAll(/<([a-z0-9]+)\b([^>]*)>/g)].filter(([, tag]) => tag !== 'meta' && tag !== 'title');
    let coloured = 0;
    for (const [whole, , attrs] of tags) {
      const style = attrs!.match(/style="([^"]*)"/)?.[1] ?? '';
      if (!/(^|;)\s*(color|background|border[a-z-]*)\s*:[^;]*#/i.test(style)) continue;
      coloured++;
      const classes = (attrs!.match(/class="([^"]*)"/)?.[1] ?? '').split(/\s+/).filter((c) => c.startsWith('d-'));
      expect(classes.length, `no dark override class on: ${whole.slice(0, 120)}`).toBeGreaterThan(0);
      for (const c of classes) expect(defined.has(c), `${c} is not defined in the dark block`).toBe(true);
    }
    expect(coloured, 'the walk actually found the coloured elements').toBeGreaterThan(30);
  });

  it('the three chip tones each have their own dark override', () => {
    for (const tone of ['neutral', 'progress', 'attention']) {
      expect(out.html).toContain(`d-chip-${tone}`);
      expect(css).toContain(`.d-chip-${tone}{`);
    }
  });

  it('has the Outlook.com [data-ogsc]/[data-ogsb] fallbacks', () => {
    expect(css).toContain('[data-ogsc] .d-ink{color:#f3efe7!important}');
    expect(css).toContain('[data-ogsb] .d-page{background-color:#0a0d12!important}');
  });
});

describe('#1251 digestSlot', () => {
  const daily = { ...DEFAULT_MY_WORK_EMAIL, frequency: 'daily' as const, time: '08:00', timezone: 'Europe/Madrid' };
  it('follows the person\'s own clock across DST: 08:00 Madrid is 06:00Z in summer and 07:00Z in winter', () => {
    expect(digestSlot(daily, new Date('2026-07-15T06:00:00Z'))?.toISOString()).toBe('2026-07-15T06:00:00.000Z');
    expect(digestSlot(daily, new Date('2026-07-15T07:00:00Z'))).toBeNull();
    expect(digestSlot(daily, new Date('2026-11-10T07:00:00Z'))?.toISOString()).toBe('2026-11-10T07:00:00.000Z');
  });
  it('is off when off, and weekly only on its weekday', () => {
    expect(digestSlot(DEFAULT_MY_WORK_EMAIL, new Date('2026-11-10T09:00:00Z'))).toBeNull();
    const weekly = { ...DEFAULT_MY_WORK_EMAIL, frequency: 'weekly' as const, weekday: 5, time: '16:00', timezone: 'Asia/Tokyo' };
    expect(digestSlot(weekly, new Date('2026-11-13T07:00:00Z'))?.toISOString()).toBe('2026-11-13T07:00:00.000Z'); // Fri 16:00 JST
    expect(digestSlot(weekly, new Date('2026-11-12T07:00:00Z'))).toBeNull();
  });
});
