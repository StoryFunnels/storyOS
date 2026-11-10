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
