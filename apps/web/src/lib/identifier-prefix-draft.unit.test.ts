import { describe, expect, it } from 'vitest';
import { identifierPrefixDraft, identifierPrefixHelper } from './identifier-prefix-draft';

/** Ticket #1381 — the web-side preview of the API's prefix rule. Pins what must be ACCEPTED as well as what is refused. */
describe('#1381 identifierPrefixDraft', () => {
  it('accepts the shapes the API accepts: 2-10 capitals/digits starting with a letter', () => {
    for (const ok of ['ISSUE', 'SF', 'ENG2', 'ABCDEFGHIJ']) {
      expect(identifierPrefixDraft(ok, null), ok).toMatchObject({ value: ok, error: null });
    }
  });

  it('refuses what the API refuses, with the schema wording', () => {
    for (const bad of ['A', 'ABCDEFGHIJK', '1ABC', 'AB-C', 'AB C', 'ÉCOLE']) {
      const d = identifierPrefixDraft(bad, null);
      expect(d.error, bad).toMatch(/2-10 characters/);
    }
  });

  it('upper-cases lowercase typing instead of refusing it, and trims', () => {
    expect(identifierPrefixDraft('  issue ', null)).toMatchObject({ value: 'ISSUE', error: null });
  });

  it('an empty box is a legitimate clear: null, no error', () => {
    expect(identifierPrefixDraft('', 'ISSUE')).toMatchObject({ value: null, error: null, unchanged: false });
    expect(identifierPrefixDraft('   ', 'ISSUE').value).toBeNull();
  });

  it('flags unchanged so Save does not send a no-op: same prefix, or empty over empty', () => {
    expect(identifierPrefixDraft('ISSUE', 'ISSUE').unchanged).toBe(true);
    expect(identifierPrefixDraft('issue', 'ISSUE').unchanged).toBe(true);
    expect(identifierPrefixDraft('', null).unchanged).toBe(true);
    expect(identifierPrefixDraft('', undefined).unchanged).toBe(true);
    expect(identifierPrefixDraft('BUG', 'ISSUE').unchanged).toBe(false);
  });

  it('the helper line shows the typed prefix once valid, else the ISSUE example, and always says how to clear', () => {
    expect(identifierPrefixHelper(identifierPrefixDraft('ENG', null))).toBe('Records show as ENG-123. Leave empty to show #123.');
    expect(identifierPrefixHelper(identifierPrefixDraft('', null))).toBe('Records show as ISSUE-123. Leave empty to show #123.');
    expect(identifierPrefixHelper(identifierPrefixDraft('1x', null))).toBe('Records show as ISSUE-123. Leave empty to show #123.');
  });
});
