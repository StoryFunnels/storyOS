import { createElement, isValidElement } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NOT_PUBLISHED_YET } from '@/lib/runners/words';
import { CommandBlock, CopyButton, PairingCode } from './pairing-blocks';

/**
 * Ticket #1209. The code is ONE block with no space character, Copy puts the unspaced code on the clipboard, and the
 * "not published yet" line is there with its link. Asserted on rendered output, not source text.
 */

/** Every CopyButton in a component's own tree, by calling the function components down to host elements (no DOM needed). */
function copyButtons(node: ReactNode): Array<{ text: string; label: string }> {
  const out: Array<{ text: string; label: string }> = [];
  const walk = (n: ReactNode): void => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!isValidElement(n)) return;
    const el = n as ReactElement<{ children?: ReactNode; text?: string; label?: string }>;
    if (el.type === CopyButton) out.push({ text: el.props.text!, label: el.props.label! });
    else if (typeof el.type === 'function') walk((el.type as (p: unknown) => ReactNode)(el.props));
    walk(el.props.children);
  };
  walk(node);
  return out;
}

const html = (code: string) => renderToStaticMarkup(createElement(PairingCode, { code }));

describe('the pairing code block', () => {
  it('shows the code as one unbroken run: no space character, in the text or the label', () => {
    const out = html('7PVUVC');
    const text = out.match(/data-testid="pairing-code"[^>]*>([^<]*)</)![1];
    expect(text).toBe('7PVUVC');
    // `\s` already covers U+00A0 and the other Unicode spaces.
    expect(text).not.toMatch(/\s|&nbsp;/);
    expect(out).not.toContain('7PV UVC');
    expect(out).not.toContain('7PV&nbsp;UVC');
  });

  it('is one selectable unit and sets the spacing in CSS, not in the text', () => {
    const out = html('7PVUVC');
    expect(out).toContain('select-all');
    expect(out).toContain('font-mono');
    expect(out).toContain('tracking-[0.18em]');
  });

  it('tidies a code that arrives with a space, a dash or lower case', () => {
    for (const raw of ['7PV UVC', '7pv-uvc', ' 7pvuvc ']) {
      expect(html(raw).match(/data-testid="pairing-code"[^>]*>([^<]*)</)![1]).toBe('7PVUVC');
    }
  });

  it('has a Copy button that copies the UNSPACED code', () => {
    expect(copyButtons(createElement(PairingCode, { code: '7PVUVC' }))).toEqual([{ text: '7PVUVC', label: 'pairing code' }]);
    expect(copyButtons(createElement(PairingCode, { code: '7PV UVC' }))[0]!.text).toBe('7PVUVC');
    const out = html('7PVUVC');
    expect(out).toContain('aria-label="Copy pairing code"');
    expect(out).toContain('>Copy<');
  });

  it('reads the code one character at a time without a grouped copy of it anywhere in the markup', () => {
    const out = html('7PVUVC');
    expect(out).toContain('aria-label="Pairing code 7 P V U V C"');
    expect(out).not.toMatch(/7PV[ -]UVC/);
  });
});

describe('the command block', () => {
  it('uses the SAME Copy control as the code, with the command on the clipboard', () => {
    expect(copyButtons(createElement(CommandBlock))).toEqual([{ text: 'npx @storyos/runner', label: 'npx @storyos/runner' }]);
    const a = renderToStaticMarkup(createElement(CommandBlock));
    const b = html('7PVUVC');
    const button = (s: string) => s.match(/<button[^>]*class="([^"]*)"/)![1];
    expect(button(a)).toBe(button(b));
  });

  it('carries the "not published yet" line, muted, linking to the Runner guide', () => {
    const out = renderToStaticMarkup(createElement(CommandBlock));
    expect(out).toContain('data-testid="not-published-line"');
    expect(out).toContain('Not published yet? Run it from the repo: see the <a');
    expect(out).toContain(`href="${NOT_PUBLISHED_YET.href}"`);
    expect(out).toContain('>Runner guide</a>.');
    expect(out).toMatch(/<p class="[^"]*text-muted[^"]*" data-testid="not-published-line"/);
  });

  it('points at a page that exists in the docs site', async () => {
    const { existsSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const slug = new URL(NOT_PUBLISHED_YET.href).pathname.replace(/^\/|\/$/g, '');
    const file = fileURLToPath(new URL(`../../../../docs/src/content/docs/${slug}.md`, import.meta.url));
    expect(existsSync(file)).toBe(true);
  });
});
