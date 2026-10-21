import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * #1005 — dates are displayed through ONE formatter (`lib/format.ts`, reached as `useDateFormat()`), so a person who
 * picked a date format, or none, sees every date the same way. This fails on a hand-rolled `toLocaleDateString` /
 * `toLocaleTimeString` / `new Date(…).toLocaleString()` anywhere else.
 *
 * Each allowed file says WHY it is not a displayed date value, and the test also fails if an allowed file stops
 * matching — an exemption outliving its reason would quietly license the next hand-rolled format.
 */
const SRC = join(__dirname, '..');
const HAND_ROLLED = /\.toLocale(?:Date|Time)String\(|new Date\([^)]*\)\.toLocaleString\(/;

const ALLOWED: Record<string, string> = {
  'lib/format.ts': 'the formatter itself',
  'components/views/timeline-view.tsx': 'axis labels of the timeline (a month name or a day tick), not a stored value',
  'components/views/calendar-view.tsx': 'the calendar’s own heading ("Oct 2026", the week range), not a stored value',
  'components/views/calendar-time-grid.tsx': 'weekday names for the column headers',
  'app/s/[token]/page.tsx':
    'server-rendered public skill page: there is no viewer locale or preference on the server; it prints a month name, never numerals',
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.(unit\.)?test\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

describe('one date formatter (#1005)', () => {
  const files = walk(SRC).map((p) => ({ rel: relative(SRC, p).split('\\').join('/'), text: readFileSync(p, 'utf8') }));

  it('no file outside the allow-list formats a date by hand', () => {
    const offenders = files.filter((f) => !(f.rel in ALLOWED) && HAND_ROLLED.test(f.text)).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it.each(Object.keys(ALLOWED))('%s still matches, so its exemption is still needed', (rel) => {
    const f = files.find((x) => x.rel === rel);
    expect(f, `${rel} no longer exists — drop it from ALLOWED`).toBeDefined();
    expect(HAND_ROLLED.test(f!.text), `${rel} no longer formats a date by hand — drop it from ALLOWED`).toBe(true);
  });
});
