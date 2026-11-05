import { describe, expect, it } from 'vitest';
import { focusIsLost, restoreFocusAfterRefusal, selectedRadioSelector, type FocusDoc, type FocusEl } from './pack-reuse-focus';

const el = (role: string | null = null): FocusEl & { focused: number } => {
  const e = { focused: 0, focus() { e.focused += 1; }, getAttribute: (n: string) => (n === 'role' ? role : null) };
  return e;
};
const doc = (active: FocusEl | null, radios: Record<string, FocusEl> = {}): FocusDoc & { asked: string[] } => {
  const d = { activeElement: active, body: {} as unknown, asked: [] as string[], querySelector(sel: string) { d.asked.push(sel); return radios[sel] ?? null; } };
  return d;
};

describe('keyboard focus after a refused pick (ticket #1176, Vera)', () => {
  it('focus is lost when it is on nothing, the body, or the dialog container', () => {
    expect(focusIsLost(doc(null))).toBe(true);
    const d = doc(null); d.activeElement = d.body as FocusEl;
    expect(focusIsLost(d)).toBe(true);
    expect(focusIsLost(doc(el('dialog')))).toBe(true);
    expect(focusIsLost(doc(el()))).toBe(false);
  });
  it('lost focus goes to the refused row’s selected radio', () => {
    const radio = el();
    const d = doc(el('dialog'), { [selectedRadioSelector('Issues')]: radio });
    expect(restoreFocusAfterRefusal(d, ['Issues'])).toBe(true);
    expect(radio.focused).toBe(1);
  });
  it('focus that is somewhere else is left alone', () => {
    const radio = el();
    const d = doc(el(), { [selectedRadioSelector('Issues')]: radio });
    expect(restoreFocusAfterRefusal(d, ['Issues'])).toBe(false);
    expect(radio.focused).toBe(0);
    expect(d.asked).toEqual([]);
  });
  it('a row that is not on the page changes nothing, and the next refused row is tried', () => {
    const second = el();
    const d = doc(el('dialog'), { [selectedRadioSelector('Projects')]: second });
    expect(restoreFocusAfterRefusal(d, ['Issues', 'Projects'])).toBe(true);
    expect(second.focused).toBe(1);
    expect(restoreFocusAfterRefusal(doc(el('dialog')), ['Issues'])).toBe(false);
  });
  it('the selector targets the row by its database name and escapes quotes', () => {
    expect(selectedRadioSelector('Issues')).toBe('[data-testid="pack-reuse-choice"][data-database="Issues"] input[type="radio"]:checked');
    expect(selectedRadioSelector('My "Issues"')).toContain('data-database="My \\"Issues\\""');
  });
  it('wiring: the dialog restores focus whenever it refuses a pick (guard on the source)', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../components/pack-install-dialog.tsx'), 'utf8') as string;
    expect(src).toContain('restoreFocusAfterRefusal(document, names)');
  });
});
