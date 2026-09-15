import { describe, expect, it } from 'vitest';
import { embedThemeStyle } from './embed-theme';

function luminance(hex: string): number {
  const h = hex.length === 4 ? hex.slice(1).split('').map((c) => c + c).join('') : hex.slice(1);
  const ch = (i: number) => {
    const v = parseInt(h.slice(i * 2, i * 2 + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch(0) + 0.7152 * ch(1) + 0.0722 * ch(2);
}
/** Accepts `string | undefined` so an unset token FAILS the test loudly rather
 *  than being silently skipped — indexing a Record gives `string | undefined`
 *  under noUncheckedIndexedAccess, and `!` would hide a missing token. */
function ratio(a: string | undefined, b: string | undefined): number {
  if (a === undefined || b === undefined) throw new Error('expected a colour, got undefined');
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/**
 * #711 phase 1. This config is stored by the builder, but it is rendered into a
 * style attribute on a PUBLIC, unauthenticated page — so the rejection cases
 * below are the point of this file, not the happy path. The API validates on
 * write; this proves the renderer does not trust that.
 */
describe('embedThemeStyle', () => {
  describe('spec §2: absent config emits nothing at all', () => {
    it.each([
      ['null', null],
      ['undefined', undefined],
      ['an empty object', {}],
      ['a string', 'accent'],
      ['a number', 5],
      ['an array', []],
    ])('returns undefined for %s', (_label, input) => {
      expect(embedThemeStyle(input)).toBeUndefined();
    });

    it('returns undefined — not {} — when every value is rejected, so React emits no style attribute', () => {
      expect(embedThemeStyle({ accent: 'url(https://evil.example/x)', radius: 999 })).toBeUndefined();
    });
  });

  describe('rejects anything that is not a plain hex colour', () => {
    it.each([
      // The exfiltration vector the ticket names by name.
      'url(https://evil.example/pixel.png)',
      '#fff;background-image:url(https://evil.example/x)',
      // Closing the declaration and starting another.
      '#fff;position:fixed',
      '#fff}body{display:none',
      // Reading a property we did not intend to expose.
      'var(--some-secret)',
      'expression(alert(1))',
      'javascript:alert(1)',
      'image-set(url(https://evil.example/x))',
      '</style><script>alert(1)</script>',
      // Valid CSS colours that are deliberately NOT accepted: hex only.
      'rgb(255,0,0)',
      'hsl(38 92% 50%)',
      'red',
      'currentColor',
      // Malformed hex.
      '#ff',
      '#fffff',
      '#ggg',
      '#1234567',
      'fff',
    ])('drops accent = %s', (accent) => {
      expect(embedThemeStyle({ accent })).toBeUndefined();
    });

    it('rejects alpha hex, which is excluded deliberately rather than forgotten', () => {
      expect(embedThemeStyle({ accent: '#ffffff80' })).toBeUndefined();
      expect(embedThemeStyle({ accent: '#fff8' })).toBeUndefined();
    });

    it('drops a non-string colour', () => {
      expect(embedThemeStyle({ accent: 123 })).toBeUndefined();
      expect(embedThemeStyle({ text: { toString: () => '#fff' } })).toBeUndefined();
    });

    it('accepts both hex lengths, and trims surrounding whitespace', () => {
      expect(embedThemeStyle({ text: '#abc' })?.['--text-primary' as never]).toBe('#abc');
      expect(embedThemeStyle({ text: ' #1c1917 ' })?.['--text-primary' as never]).toBe('#1c1917');
    });
  });

  describe('radius', () => {
    it('reproduces today’s scale exactly at the default of 6', () => {
      const s = embedThemeStyle({ radius: 6 }) as Record<string, string>;
      expect(s['--radius-chip']).toBe('4px');
      expect(s['--radius-control']).toBe('6px');
      expect(s['--radius-card']).toBe('8px');
      expect(s['--radius-modal']).toBe('12px');
    });

    it('squares every corner at 0 — an additive scale would leave a 6px modal', () => {
      const s = embedThemeStyle({ radius: 0 }) as Record<string, string>;
      expect(Object.values(s)).toEqual(['0px', '0px', '0px', '0px']);
    });

    it.each([
      ['a negative radius', -1],
      ['a radius past the range', 17],
      ['a fractional radius', 6.5],
      ['a numeric string', '6'],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
    ])('drops %s rather than clamping it', (_label, radius) => {
      expect(embedThemeStyle({ radius })).toBeUndefined();
    });
  });

  describe('derivation: four controls, not eighteen tokens', () => {
    it('derives the whole text hierarchy from the ink, toward the surface', () => {
      const s = embedThemeStyle({ text: '#1c1917', surface: '#ffffff' }) as Record<string, string>;
      expect(s['--text-primary']).toBe('#1c1917');
      for (const step of ['--text-secondary', '--text-muted', '--text-faint']) {
        expect(s[step]).toMatch(/^#[0-9a-f]{6}$/);
      }
    });

    it('keeps the three steps ORDERED, so an embedder cannot flatten the hierarchy', () => {
      const s = embedThemeStyle({ text: '#1c1917', surface: '#ffffff' }) as Record<string, string>;
      const c = (hex: string | undefined) => ratio(hex, '#ffffff');
      expect(c(s['--text-primary'])).toBeGreaterThan(c(s['--text-secondary']));
      expect(c(s['--text-secondary'])).toBeGreaterThan(c(s['--text-muted']));
      expect(c(s['--text-muted'])).toBeGreaterThan(c(s['--text-faint']));
    });

    it('falls back to CSS blending when only `text` is set — the surface is unmeasurable then', () => {
      const s = embedThemeStyle({ text: '#1c1917' }) as Record<string, string>;
      expect(s['--text-muted']).toBe('color-mix(in srgb, #1c1917 62%, var(--bg-card))');
    });

    it('treats `surface` as the INPUT surface — there is no card in embed mode', () => {
      const s = embedThemeStyle({ surface: '#ffffff' }) as Record<string, string>;
      expect(s['--bg-card']).toBe('#ffffff');
      expect(s).not.toHaveProperty('--bg-app');
    });

    it('never exposes --error, which is semantic rather than brand', () => {
      const s = embedThemeStyle({ accent: '#c0392b', text: '#111111', surface: '#ffffff', radius: 8 });
      expect(s).not.toHaveProperty('--error');
    });
  });

  /**
   * The submit button's label. A pale accent with white text makes the form's
   * primary action unreadable — the one control the page exists to get clicked.
   */
  describe('--text-on-dark is derived from accent and never settable', () => {
    it('picks near-black on a pale accent', () => {
      const s = embedThemeStyle({ accent: '#f5e663' }) as Record<string, string>;
      expect(s['--text-on-dark']).toBe('#1c1917');
    });

    it('picks white on a dark accent', () => {
      const s = embedThemeStyle({ accent: '#0f1729' }) as Record<string, string>;
      expect(s['--text-on-dark']).toBe('#ffffff');
    });

    it('ignores a --text-on-dark the caller tries to supply', () => {
      const s = embedThemeStyle({
        accent: '#f5e663',
        'text-on-dark': '#ffffff',
        '--text-on-dark': '#ffffff',
      }) as Record<string, string>;
      expect(s['--text-on-dark']).toBe('#1c1917');
    });

    it('clears 4.5:1 for every accent across the hue circle', () => {
      // A mid-toned accent is the genuinely hard case and can fall short of
      // 4.5:1 for BOTH candidates; the builder warns there (spec §6). What must
      // hold unconditionally is that we always return the BETTER of the two.
      const accents = ['#e11d48', '#d4a017', '#2f7d32', '#1d4ed8', '#7c3aed', '#0f1729', '#f5e663'];
      for (const a of accents) {
        const got = (embedThemeStyle({ accent: a }) as Record<string, string>)['--text-on-dark'];
        const other: string = got === '#ffffff' ? '#1c1917' : '#ffffff';
        expect(ratio(got, a)).toBeGreaterThanOrEqual(ratio(other, a));
      }
    });
  });

  /**
   * The spec's fixed percentages (85/62/45) reproduce today's hierarchy against
   * today's palette. The ticket flagged them as a starting point to check
   * against real host brands rather than a result. This is that check, and it
   * failed on the first real brand: text #2c2419 on surface #fbf7ef put muted
   * text at 4.32:1 -- below 4.5:1, and below the 5.44:1 the UNTHEMED form
   * already achieves. A percentage cannot hold a floor across arbitrary
   * colours, so the floor is enforced and the percentage is only a start.
   */
  describe('contrast floors hold across real host brands', () => {
    const brands: [string, string][] = [
      ['#2c2419', '#fbf7ef'], // warm cream — the pair that caught the 4.32:1 bug
      ['#1c1917', '#ffffff'], // stock-ish
      ['#0f1729', '#f4f6fb'], // cool grey
      ['#3f141e', '#fff8f0'], // wine on blush
      ['#14532d', '#f0fdf4'], // forest on mint
      ['#1e1b4b', '#eef2ff'], // indigo on periwinkle
    ];

    it.each(brands)('text %s on surface %s clears 4.5:1 for real content text', (text, surface) => {
      const s = embedThemeStyle({ text, surface }) as Record<string, string>;
      expect(ratio(s['--text-secondary'], surface)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(s['--text-muted'], surface)).toBeGreaterThanOrEqual(4.5);
    });

    it.each(brands)('text %s on surface %s clears 3:1 for the faint attribution', (text, surface) => {
      const s = embedThemeStyle({ text, surface }) as Record<string, string>;
      expect(ratio(s['--text-faint'], surface)).toBeGreaterThanOrEqual(3);
    });

    it('regression: the exact pair that measured 4.32:1 in the browser', () => {
      const s = embedThemeStyle({ text: '#2c2419', surface: '#fbf7ef' }) as Record<string, string>;
      expect(ratio(s['--text-muted'], '#fbf7ef')).toBeGreaterThanOrEqual(4.5);
    });

    it('does not blow past the floor — a step that already clears it is left alone', () => {
      // #1c1917 on #ffffff clears 4.5:1 at the starting 62%, so muted must NOT
      // be darkened all the way to the ink: the hierarchy has to survive.
      const s = embedThemeStyle({ text: '#1c1917', surface: '#ffffff' }) as Record<string, string>;
      expect(s['--text-muted']).not.toBe('#1c1917');
      expect(ratio(s['--text-muted'], '#ffffff')).toBeLessThan(ratio('#1c1917', '#ffffff'));
    });
  });
});
