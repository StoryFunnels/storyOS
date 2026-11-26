import { describe, expect, it } from 'vitest';
import { parseIdentifier } from '@storyos/schemas/identifier';
import { recordHandle } from './records';

/** Ticket #1363 — the record header and the details panel read ONE rule for "what is this record called". */
describe('recordHandle', () => {
  it('is the identifier when the database has a prefix', () => {
    expect(recordHandle({ identifier: 'ISSUE-5201', number: 5201 })).toBe('ISSUE-5201');
  });
  it('is #number when there is no prefix, exactly as before', () => {
    expect(recordHandle({ identifier: null, number: 17 })).toBe('#17');
    expect(recordHandle({ number: 17 })).toBe('#17');
  });
  it('is null when the record has no number yet (and so no identifier)', () => {
    expect(recordHandle({ identifier: null, number: null })).toBeNull();
    expect(recordHandle({})).toBeNull();
  });
});

describe('the identifier shape the /i/ route and the MCP tool share', () => {
  it('parses ISSUE-5201 in any case and returns the canonical prefix', () => {
    expect(parseIdentifier('ISSUE-5201')).toEqual({ prefix: 'ISSUE', number: 5201 });
    expect(parseIdentifier(' issue-5201 ')).toEqual({ prefix: 'ISSUE', number: 5201 });
    expect(parseIdentifier('Sf2-1')).toEqual({ prefix: 'SF2', number: 1 });
  });
  it('refuses what is not an identifier', () => {
    for (const bad of ['', 'ISSUE', 'ISSUE-', '-5', 'ISSUE-0', 'ISSUE-abc', 'I-5', 'ELEVENCHARSX-5', 'ISSUE-99999999999', 'ISSUE 5201', '5201']) {
      expect(parseIdentifier(bad), bad).toBeNull();
    }
  });
});
