import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { OPTION_COLORS } from '@/components/table-view/option-colors';
import { AVATAR_DARKEN, Avatar, avatarFill } from './avatar';

const lin = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = ([r, g, b]: number[]) => 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!);
const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
/** White initials on the avatar fill: the fill is the colour with each channel scaled by (1 - AVATAR_DARKEN). */
const whiteOn = (h: string) => 1.05 / (lum(hex(h).map((c) => c * (1 - AVATAR_DARKEN))) + 0.05);

/** Ticket #1277 item 4: one avatar everywhere, a solid colour with white initials (the design's), not an 18% wash. */
describe('Avatar: solid colour, white initials', () => {
  it('white initials reach 4.5:1 on EVERY palette colour (raw gold, orange and teal do not: that is why the fill is darkened)', () => {
    const colours = Object.entries(OPTION_COLORS);
    expect(colours.length).toBeGreaterThanOrEqual(15);
    for (const [name, value] of colours) expect(whiteOn(value), name).toBeGreaterThanOrEqual(4.5);
    const raw = (h: string) => 1.05 / (lum(hex(h)) + 0.05);
    expect(Math.min(...colours.map(([, v]) => raw(v)))).toBeLessThan(4.5); // the darkening is load-bearing
  });

  it('the fill is the palette colour mixed toward black by AVATAR_DARKEN', () => {
    expect(avatarFill('#2563EB')).toBe('color-mix(in srgb, #2563EB 85%, black)');
  });

  it('renders an 18px avatar with 10px/600 white initials and the full name for hover, no tint class', () => {
    const html = renderToStaticMarkup(createElement(Avatar, { userId: 'u1', name: 'Ada Lovelace', size: 18 }));
    expect(html).toContain('h-[18px] w-[18px] text-[10px]');
    expect(html).toContain('font-semibold');
    expect(html).toContain('text-white');
    expect(html).toContain('>AL<');
    expect(html).toContain('title="Ada Lovelace"');
    expect(html).not.toContain('option-tint'); // the 18% wash is gone
  });

  it('KEEPS: a 16px avatar shows one initial, a photo wins over initials, the colour is stable per user id', () => {
    expect(renderToStaticMarkup(createElement(Avatar, { userId: 'u1', name: 'Ada Lovelace', size: 16 }))).toContain('>A<');
    const img = renderToStaticMarkup(createElement(Avatar, { userId: 'u1', name: 'Ada', image: 'https://x.test/a.png' }));
    expect(img).toContain('<img');
    const a = renderToStaticMarkup(createElement(Avatar, { userId: 'same', name: 'A B' }));
    const b = renderToStaticMarkup(createElement(Avatar, { userId: 'same', name: 'A B' }));
    expect(a).toBe(b);
  });
});
