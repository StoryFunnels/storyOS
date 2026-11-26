import { describe, expect, it } from 'vitest';
import { MAX_PDF_BASENAME, fieldValueText, recordToBlocks, safePdfFilename, withDateToken } from './attach-pdf-model';
import type { PdfFieldDef } from './attach-pdf-model';

describe('safePdfFilename (ticket #877)', () => {
  it('keeps a normal name and adds .pdf exactly once', () => {
    expect(safePdfFilename('Quote Quarry Hill · 2026-11-26')).toBe('Quote Quarry Hill · 2026-11-26.pdf');
    expect(safePdfFilename('Quote.pdf')).toBe('Quote.pdf');
    expect(safePdfFilename('Quote.PDF.pdf')).toBe('Quote.pdf');
  });

  it('removes path separators and traversal, whatever the record title held', () => {
    for (const hostile of ['../../etc/passwd', '..\\..\\windows\\system32', '/abs/path', 'a/b\\c', '....//....//x', 'C:\\x']) {
      const out = safePdfFilename(hostile);
      expect(out, hostile).not.toMatch(/[\\/]/);
      expect(out, hostile).not.toContain('..');
      expect(out.startsWith('.'), hostile).toBe(false);
      expect(out.endsWith('.pdf'), hostile).toBe(true);
    }
  });

  it('removes control characters, header-breaking quotes and bidi overrides', () => {
    expect(safePdfFilename('a\r\nSet-Cookie: x=1')).not.toMatch(/[\r\n]/);
    expect(safePdfFilename('he said "hi"')).not.toContain('"');
    expect(safePdfFilename('invoice\u202egnp.pdf')).not.toMatch(/\u202e/);
    expect(safePdfFilename('nul\u0000byte')).not.toContain('\u0000');
  });

  it('caps the length and never splits a surrogate pair', () => {
    const long = safePdfFilename('x'.repeat(5000));
    expect(long.length).toBe(MAX_PDF_BASENAME + '.pdf'.length);
    const emoji = safePdfFilename('😀'.repeat(200));
    expect(emoji.endsWith('.pdf')).toBe(true);
    expect(emoji).not.toMatch(/[\ud800-\udbff]\.pdf$/);
  });

  it('falls back to a name for an empty or all-hostile input, never an empty or dot-only one', () => {
    for (const empty of ['', '   ', '///', '....', '.pdf', '\u0000']) expect(safePdfFilename(empty), JSON.stringify(empty)).toBe('document.pdf');
  });
});

describe('withDateToken', () => {
  it('replaces only the exact {date} token with the UTC day', () => {
    expect(withDateToken('{title} · {date}', new Date('2026-11-26T23:59:00Z'))).toBe('{title} · 2026-11-26');
    expect(withDateToken('{Date} {datex}', new Date('2026-11-26T00:00:00Z'))).toBe('{Date} {datex}');
  });
});

const field = (over: Partial<PdfFieldDef> & Pick<PdfFieldDef, 'apiName' | 'displayName' | 'type'>): PdfFieldDef => ({
  id: over.apiName,
  position: 0,
  isSystem: false,
  config: {},
  ...over,
});
const none = { optionLabels: new Map<string, string>(), userNames: new Map<string, string>() };

describe('recordToBlocks (ticket #877)', () => {
  const fields = [
    field({ apiName: 'name', displayName: 'Name', type: 'text' }),
    field({ apiName: 'status', displayName: 'Status', type: 'select', position: 2 }),
    field({ apiName: 'client', displayName: 'Client', type: 'text', position: 1 }),
    field({ apiName: 'secret', displayName: 'Internal margin', type: 'text', position: 3, config: { entity_hidden: true } }),
    field({ apiName: 'empty', displayName: 'Empty', type: 'text', position: 4 }),
    field({ apiName: 'sys', displayName: 'System thing', type: 'text', position: 5, isSystem: true }),
  ];
  const input = {
    fields,
    values: { name: 'T', status: 'o1', client: 'Quarry Hill', secret: '42%', empty: '', sys: 'x' },
    optionLabels: new Map([['o1', 'Sent']]),
    userNames: new Map<string, string>(),
    description: null,
  };
  const text = (blocks: unknown[]) =>
    blocks.map((b) => ((b as { content: Array<{ text: string }> }).content ?? []).map((c) => c.text).join('')).join('\n');

  it('draws visible fields in panel order with labels, and keeps hidden, empty, system and the title field OUT', () => {
    expect(text(recordToBlocks(input))).toBe('Client: Quarry Hill\nStatus: Sent');
  });

  it('a field hidden in the panel stays out even though it holds a value (what the panel hides, the PDF hides)', () => {
    expect(text(recordToBlocks(input))).not.toContain('42%');
  });

  it('appends the description under a heading, and omits the heading when there is none', () => {
    const withDescription = recordToBlocks({ ...input, description: [{ type: 'paragraph', content: [{ type: 'text', text: 'Scope: site build', styles: {} }] }] });
    expect(text(withDescription)).toContain('Description\nScope: site build');
    expect(text(recordToBlocks({ ...input, description: [] }))).not.toContain('Description');
  });

  it('honours an explicit entity_order over position', () => {
    const reordered = fields.map((f) => (f.apiName === 'status' ? { ...f, config: { entity_order: -1 } } : f));
    expect(text(recordToBlocks({ ...input, fields: reordered }))).toBe('Status: Sent\nClient: Quarry Hill');
  });
});

describe('fieldValueText', () => {
  it('reads options, people, relations, checkboxes and attachments the way the panel would', () => {
    const ctx = { optionLabels: new Map([['a', 'Alpha']]), userNames: new Map([['u1', 'Maya Chen']]) };
    expect(fieldValueText(field({ apiName: 'x', displayName: 'X', type: 'multi_select' }), ['a', 'gone'], ctx)).toBe('Alpha');
    expect(fieldValueText(field({ apiName: 'x', displayName: 'X', type: 'user' }), ['u1'], ctx)).toBe('Maya Chen');
    expect(fieldValueText(field({ apiName: 'x', displayName: 'X', type: 'relation' }), [{ id: '1', title: 'Contract' }, { id: '2', title: 'Brief' }], ctx)).toBe('Contract, Brief');
    expect(fieldValueText(field({ apiName: 'x', displayName: 'X', type: 'checkbox' }), false, ctx)).toBe('No');
    expect(fieldValueText(field({ apiName: 'x', displayName: 'X', type: 'attachment' }), [{ id: 'f', filename: 'a.pdf' }], ctx)).toBe('a.pdf');
  });

  it('returns null for nothing to show (so the row is dropped, not printed as "Label: ")', () => {
    for (const v of [null, undefined, '', []]) expect(fieldValueText(field({ apiName: 'x', displayName: 'X', type: 'text' }), v, none)).toBeNull();
  });

  it('a select whose option no longer exists shows nothing rather than a raw uuid', () => {
    expect(fieldValueText(field({ apiName: 'x', displayName: 'X', type: 'select' }), 'deadbeef', none)).toBeNull();
  });
});
