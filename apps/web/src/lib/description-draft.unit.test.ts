import { describe, expect, it } from 'vitest';
import { DESCRIPTION_MAX } from '@storyos/schemas';
import { describeDraft } from './description-draft';

/**
 * #457 criterion 6 — one definition of what a half-typed description means.
 *
 * The first cut shipped two: the dialog and the workspace settings page each
 * re-derived the trim, the over-limit test, the clear-to-null rule and the counter
 * wording. They were identical, which is how every one of #267 / #272 / #303
 * started. These tests pin the single definition so a future copy has something to
 * disagree with.
 */
describe('#457 describeDraft — the one web-side description rule', () => {
  describe('clear-to-null: an emptied box REMOVES the description', () => {
    it('is null for an empty string', () => {
      expect(describeDraft('').value).toBeNull();
    });

    it('is null for whitespace only — spaces, tabs and newlines', () => {
      expect(describeDraft('   ').value).toBeNull();
      expect(describeDraft('\n\t  \n').value).toBeNull();
    });

    it('never yields an empty string, which would make absent and empty two states', () => {
      // #305: unconfigured is not invalid — and it should not be two things that
      // render identically either.
      expect(describeDraft('  ').value).not.toBe('');
    });
  });

  describe('what gets sent', () => {
    it('sends the RAW text, leaving final normalisation to the server', () => {
      // Deliberately not the collapsed form: the server's normalizeDescription is
      // the one authority on what is stored, and this module must not become a
      // second one.
      expect(describeDraft('  hello   world  ').value).toBe('  hello   world  ');
    });
  });

  describe('length is measured on what the server will STORE', () => {
    it('collapses whitespace runs before counting', () => {
      expect(describeDraft('a     b').length).toBe(3); // "a b"
    });

    it('ignores a trailing newline rather than counting it against the limit', () => {
      const exact = 'x'.repeat(DESCRIPTION_MAX);
      expect(describeDraft(`${exact}\n`).over).toBe(false);
      expect(describeDraft(`${exact}\n`).length).toBe(DESCRIPTION_MAX);
    });
  });

  describe('the limit', () => {
    it('is not over at exactly the cap', () => {
      expect(describeDraft('x'.repeat(DESCRIPTION_MAX)).over).toBe(false);
    });

    it('is over at one past the cap', () => {
      expect(describeDraft('x'.repeat(DESCRIPTION_MAX + 1)).over).toBe(true);
    });

    it('reports how far over, so the limit is visible rather than a silent 422', () => {
      expect(describeDraft('x'.repeat(DESCRIPTION_MAX + 15)).hint).toBe(
        `15 over the ${DESCRIPTION_MAX}-character limit`,
      );
    });

    it('reports what is left while under', () => {
      expect(describeDraft('x'.repeat(DESCRIPTION_MAX - 40)).hint).toBe(`40 left`);
      expect(describeDraft('').hint).toBe(`${DESCRIPTION_MAX} left`);
    });
  });

  it('reads the cap from the schema, not from a literal typed in the web app', () => {
    // If the server's bound moves, every surface moves with it. This asserts the
    // wiring, not the number.
    expect(describeDraft('x'.repeat(DESCRIPTION_MAX)).hint).toBe('0 left');
  });
});
