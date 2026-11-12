import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EmptyState } from './empty-state';

/*
 * Ticket #1291 item 4. The reference values are the design reference's computed styles, measured headless at 1270 and 390 (the
 * same at both): filtered card = flex, centred, gap 12px, padding 14px 16px, 1px dashed border, 6px radius, card background,
 * max-width 560, margin 10px 0; its reason 13px/650 ink, its sub-line 12px muted, its glyph 16px, its button 27px.
 * Big = column, centred, gap 10px, padding 28px 16px 24px, heading 14px/700. List line = 12px, padding 9px 11px.
 * Our tokens: text-label 12px, text-body 13px, text-prose 14px, --radius-card 6px, gap-3 12px, gap-2.5 10px, px-4 16px,
 * py-3.5 14px, pt-7 28px, pb-6 24px, px-[11px]/py-[9px], h-4 16px, h-[27px].
 */
const html = (props: Parameters<typeof EmptyState>[0]) => renderToStaticMarkup(createElement(EmptyState, props));
const noop = () => {};

describe('EmptyState: filtered (the compact card)', () => {
  const out = html({ variant: 'filtered', title: 'Filters hide all 10 records', body: 'Nothing here is deleted', action: { label: 'Clear filters', onClick: noop, variant: 'secondary' } });
  it('is the reference card: 12px gap, 14/16 padding, 1px dashed 6px-radius card, 560 max, 10px vertical margin', () => {
    for (const c of ['gap-3', 'px-4', 'py-3.5', 'border-dashed', 'border ', 'rounded-[var(--radius-card)]', 'bg-card', 'max-w-[560px]', 'my-2.5', 'items-center']) expect(out).toContain(c);
  });
  it('the reason is 13px/650 ink, the sub-line 12px muted, the glyph 16px, the button 27px', () => {
    expect(out).toMatch(/<b class="font-\[650\] text-ink">Filters hide all 10 records<\/b>/);
    expect(out).toMatch(/<span class="text-label">Nothing here is deleted<\/span>/);
    expect(out).toContain('h-4 w-4');
    expect(out).toContain('h-[27px] text-label font-semibold');
  });
  it('is a status region and has no big-shape chrome (no heading, no centred column)', () => {
    expect(out).toContain('role="status"');
    expect(out).not.toContain('<h3');
    expect(out).not.toContain('text-center');
  });
  it('the action is optional', () => {
    expect(html({ variant: 'filtered', title: 'x' })).not.toContain('<button');
  });
});

describe('EmptyState: big (the first-run box)', () => {
  const out = html({ variant: 'big', title: 'No agents yet', action: { label: 'Hire an agent', onClick: noop } });
  it('is a centred column box: 10px gap, 28/16/24 padding, card border', () => {
    for (const c of ['flex-col', 'items-center', 'gap-2.5', 'px-4', 'pt-7', 'pb-6', 'text-center', 'border border-border-default', 'bg-card', 'rounded-[var(--radius-card)]']) expect(out).toContain(c);
  });
  it('has one heading, 14px bold, and the one 27px action', () => {
    expect(out).toMatch(/<h3 class="[^"]*text-prose font-bold[^"]*">No agents yet<\/h3>/);
    expect(out.match(/<button/g)).toHaveLength(1);
    expect(out).toContain('h-[27px] text-label font-semibold');
  });
  it('the Quill slot draws exactly what it is given, and nothing when empty (ships without art)', () => {
    expect(out).not.toContain('<svg');
    expect(html({ variant: 'big', title: 't', quill: createElement('i', { 'data-quill': '1' }) })).toContain('<i data-quill="1"></i>');
  });
  it('fill centres the box in the pane; without it the box sits in the page flow', () => {
    expect(html({ variant: 'big', title: 't', fill: true })).toContain('h-full items-center justify-center');
    expect(out).not.toContain('h-full');
  });
  it('without an action there is no button (a reader who cannot act is not offered one)', () => {
    expect(html({ variant: 'big', title: 't', body: 'b' })).not.toContain('<button');
  });
});

describe('EmptyState: list (the secondary pane line)', () => {
  const out = html({ variant: 'list', title: 'Nothing archived.' });
  it('is one muted 12px line with 9px/11px padding', () => {
    expect(out).toContain('text-label text-muted');
    expect(out).toContain('px-[11px]');
    expect(out).toContain('py-[9px]');
    expect(out).toContain('Nothing archived.');
  });
  it('has no heading, no button, no icon', () => {
    expect(out).not.toMatch(/<h3|<button|<svg/);
  });
});
