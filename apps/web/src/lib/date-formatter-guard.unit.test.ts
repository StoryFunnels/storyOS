import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) && !/\.(unit\.)?test\.tsx?$/.test(n) ? [p] : [];
  });
const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
const rel = (f: string) => f.slice(root.length + 1);

/**
 * Ticket #1275 item 5 — dates are written by ONE formatter (lib/format.ts) on every surface. A surface that reaches for
 * `toLocaleDateString`, `Intl.DateTimeFormat` or its own month-name table writes dates in its own order and drifts from the
 * rest, which is how the calendar said "November 2026" in English whatever the viewer's locale.
 *
 * What is outside, and why (an addition here has to say why):
 */
const OUTSIDE: Record<string, string> = {
  'lib/format.ts': 'the formatter itself',
  'app/s/[token]/page.tsx': 'a server-rendered public page: there is no viewer locale on the server, so its "updated" date is pinned to en',
  'lib/my-work-email.ts': 'time-zone offsets for the email schedule, not a displayed date',
  'lib/runners/wake-rules.ts': 'time-zone offset names for a schedule, not a displayed date',
  'lib/runners/sharing.ts': 'detects the browser time zone, writes no date',
  'lib/runners/words.ts': 'Runner schedule wording, pinned to en-GB by its own contract (tracked apart from the record views)',
  'lib/runners/agent-list.ts': 'Runner schedule wording, pinned to en-GB by its own contract (tracked apart from the record views)',
};
const DATE_API = /toLocale(?:Date|Time)String|Intl\.DateTimeFormat|DateTimeFormat\(/;
const MONTH_TABLE = /['"](?:Jan|January)['"]\s*,\s*['"](?:Feb|February)['"]/i;

describe('no surface writes a date outside the shared formatter (ticket #1275 item 5)', () => {
  const files = walk(root);

  it('only the formatter (and the listed non-record-date files) calls the locale date APIs', () => {
    const offenders = files.filter((f) => DATE_API.test(strip(readFileSync(f, 'utf8'))) && !(rel(f) in OUTSIDE)).map(rel);
    expect(offenders).toEqual([]);
  });

  it('no file carries its own month-name table, except the date picker, which reads a typed month back (parsing, not display)', () => {
    const offenders = files.filter((f) => MONTH_TABLE.test(readFileSync(f, 'utf8')) && rel(f) !== 'components/ui/date-picker.tsx').map(rel);
    expect(offenders).toEqual([]);
  });

  it('every listed exception still exists and still uses the API (a stale entry is a rule about nothing)', () => {
    for (const f of Object.keys(OUTSIDE)) {
      if (f === 'lib/format.ts') continue;
      expect(DATE_API.test(strip(readFileSync(join(root, f), 'utf8'))), f).toBe(true);
    }
  });

  it('the calendar, timeline, board buckets, date picker, inbox and public view go through the formatter', () => {
    for (const f of ['components/views/calendar-view.tsx', 'components/views/calendar-time-grid.tsx', 'components/views/timeline-view.tsx', 'components/views/date-buckets.ts', 'components/ui/date-picker.tsx']) {
      expect(readFileSync(join(root, f), 'utf8'), f).toContain("from '@/lib/format'");
    }
    for (const f of ['components/inbox-panel.tsx', 'app/w/[ws]/inbox/page.tsx']) {
      expect(readFileSync(join(root, f), 'utf8'), f).toContain('fmt.age(');
    }
    expect(readFileSync(join(root, 'app/v/[token]/public-view-client.tsx'), 'utf8')).toContain("from '@/lib/format'");
  });
});
