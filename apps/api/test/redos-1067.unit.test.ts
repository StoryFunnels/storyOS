import { describe, expect, it } from 'vitest';
import { coerceFieldValue, EMAIL_RE, evaluateFormula, markdownToBlocks, parseFormula } from '@storyos/schemas';
import type { FieldDef, FormulaFieldInfo } from '@storyos/schemas';
import { markdownToHtml } from '../src/automations/send-email.action';
import { isSecretKey, redactSecrets } from '../src/common/redact-secrets';
import { inferFieldType } from '../src/migration-framework/field-type-mapping';

/**
 * #1067 — regexes that backtracked quadratically on attacker-sized input, each of which blocked the one Node event
 * loop every tenant shares. The worst: one ~3 MB email value on an ANONYMOUS public form. Each case below runs the
 * input that used to be quadratic at a size where the old form took seconds, and asserts what each fix must KEEP.
 */
const FAST_MS = 250;
const timed = (fn: () => unknown) => {
  const t = performance.now();
  fn();
  return performance.now() - t;
};

describe('#1067 email validation is linear and accepts exactly what it did', () => {
  const OLD = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  it('agrees with the old regex on every string up to length 7 over a, ".", "@", " "', () => {
    const alphabet = ['a', '.', '@', ' '];
    const diffs: string[] = [];
    const walk = (s: string) => {
      if (OLD.test(s) !== EMAIL_RE.test(s)) diffs.push(s);
      if (s.length < 7) for (const c of alphabet) walk(s + c);
    };
    walk('');
    expect(diffs).toEqual([]);
  });

  it('rejects a 3 MB adversarial value fast, through the record-value coercion the public form uses', () => {
    const field = { id: 'f', api_name: 'email', type: 'email' } as unknown as FieldDef;
    const evil = 'a@' + '.'.repeat(3_000_000) + '@';
    let result: { error?: string } = {};
    expect(timed(() => (result = coerceFieldValue(field, evil)))).toBeLessThan(FAST_MS);
    expect(result.error).toBe('expected an email address');
    expect(coerceFieldValue(field, 'ada@example.co.uk').error).toBeUndefined();
  });

  it('CSV type inference uses the same linear regex', () => {
    const evil = 'a@' + '.'.repeat(1_000_000) + '@';
    expect(timed(() => inferFieldType([evil, evil, evil]))).toBeLessThan(FAST_MS);
    expect(inferFieldType(['a@b.co', 'c@d.org', 'e@f.io']).type).toBe('email');
  });
});

describe('#1067 markdown links are linear', () => {
  it('send_email markdownToHtml: unclosed [ runs and repeated [a](http:// are fast', () => {
    expect(timed(() => markdownToHtml('['.repeat(200_000)))).toBeLessThan(FAST_MS);
    expect(timed(() => markdownToHtml('[a](http://'.repeat(20_000)))).toBeLessThan(FAST_MS);
  });

  it('send_email markdownToHtml still renders links, emphasis and code', () => {
    expect(markdownToHtml('See [the docs](https://example.com/a?b=1) **now** and `x`')).toBe(
      '<p style="margin: 0 0 12px;">See <a href="https://example.com/a?b=1">the docs</a> <strong>now</strong> and <code>x</code></p>',
    );
  });

  it('markdownToBlocks: unclosed [ runs and repeated [a](x are fast', () => {
    expect(timed(() => markdownToBlocks('['.repeat(200_000) + ' `code`'))).toBeLessThan(FAST_MS);
    expect(timed(() => markdownToBlocks('[a](x'.repeat(40_000)))).toBeLessThan(FAST_MS);
  });

  it('markdownToBlocks still parses a link', () => {
    const [para] = markdownToBlocks('Go to [StoryOS](https://storyos.dev) today') as Array<{ content: unknown[] }>;
    expect(JSON.stringify(para!.content)).toContain('https://storyos.dev');
  });
});

describe('#1067 secret redaction on hook payloads is linear', () => {
  it('a long digit-run key is fast, and a trailing counter still does not escape (password2, apiToken3)', () => {
    expect(timed(() => isSecretKey('1'.repeat(200_000) + 'a'))).toBeLessThan(FAST_MS);
    expect(isSecretKey('password2')).toBe(true);
    expect(isSecretKey('apiToken3')).toBe(true);
    expect(isSecretKey('team_12')).toBe(false);
  });

  it('a value of word boundaries is fast, and URL userinfo is still blanked', () => {
    expect(timed(() => redactSecrets({ note: 'a-'.repeat(100_000) }))).toBeLessThan(FAST_MS);
    expect(redactSecrets({ url: 'https://user:pass@example.com/x' })).toEqual({ url: 'https://[redacted]@example.com/x' });
  });
});

describe('#1067 workdays_between counts weeks instead of walking every day', () => {
  const FIELDS: FormulaFieldInfo[] = [
    { api_name: 'a', display_name: 'A', formula_type: 'date' },
    { api_name: 'b', display_name: 'B', formula_type: 'date' },
  ];
  const ast = parseFormula('workdays_between({A}, {B})', FIELDS);
  const run = (a: string, b: string) => evaluateFormula(ast, { a, b });
  /** The previous implementation, verbatim, as the oracle. */
  const walk = (a: string, b: string) => {
    const da = new Date(Date.parse(a));
    const db = new Date(Date.parse(b));
    const sign = db.getTime() < da.getTime() ? -1 : 1;
    const from = sign === 1 ? da : db;
    const to = sign === 1 ? db : da;
    let days = 0;
    const cur = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
    const end = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
    while (cur.getTime() < end) {
      cur.setUTCDate(cur.getUTCDate() + 1);
      const wd = cur.getUTCDay();
      if (wd !== 0 && wd !== 6) days += 1;
    }
    return days * sign;
  };

  it('matches the day-by-day count for every start weekday and spans 0..60 days, both directions', () => {
    const base = Date.UTC(2026, 9, 26); // a Monday
    for (let start = 0; start < 7; start++) {
      for (let span = 0; span <= 60; span++) {
        const a = new Date(base + start * 86_400_000).toISOString();
        const b = new Date(base + (start + span) * 86_400_000 + 5 * 3_600_000).toISOString();
        expect(run(a, b), `${a} -> ${b}`).toBe(walk(a, b));
        expect(run(b, a), `${b} -> ${a}`).toBe(walk(b, a));
      }
    }
  });

  it('a span of ~270k years is instant', () => {
    let out: unknown;
    expect(timed(() => (out = run('-270000-01-01', '+270000-01-01')))).toBeLessThan(FAST_MS);
    expect(typeof out).toBe('number');
  });
});
