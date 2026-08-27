import { describe, expect, it } from 'vitest';
import { assertsWorkspaceQuantity } from './grounding';

/**
 * #401 — never guess numbers, always count.
 *
 * The founder's rule is absolute, so this is written as two lists that must
 * both hold. The FIRST is the defect. The SECOND is the damage a heavy-handed
 * fix would do: a guard that trips on every number pushes Tyron into hedging
 * everything, which is #358's lesson — the half that keeps it usable matters as
 * much as the half that keeps it safe.
 */
describe('#401 detecting a fabricated data quantity', () => {
  it('catches the exact sentence that shipped on production', () => {
    // The real answer was 148. It made "50" up, with zero tool calls.
    expect(assertsWorkspaceQuantity('There are currently 50 companies listed in the database.')).toBe(true);
  });

  it.each([
    'You have 12 records in Tasks.',
    'I found 7 items matching that.',
    'There are 3 databases in your workspace.',
    'The total is 42 rows.',
    'Currently there are twelve entries.',
    // A hedge is not a fix — the rule forbids the guess, not the confidence.
    'There are several companies in the database.',
    'You have dozens of records there.',
    'I see roughly a few hundred rows in that table.',
  ])('withholds: %s', (text) => {
    expect(assertsWorkspaceQuantity(text)).toBe(true);
  });

  it.each([
    // The AC names this one explicitly. It must pass.
    'I can help with 2 things.',
    'There are 3 ways to do this.',
    'Step 1: open the database.',
    "Here are 5 suggestions for naming it.",
    // A capability or a limit is not a count of anything.
    'I can create up to 100 records at a time.',
    'The maximum is 200 rows per request.',
    // A QUESTION is the behaviour we want, not a claim to suppress.
    'Which database should I count — you have several?',
    'Do you want me to count all 3 databases?',
    // No quantity at all.
    "I don't know how many companies you have.",
    'I cannot provide an exact count without accessing the database.',
    // A quantity with nothing to do with the data.
    'That will take about 5 minutes.',
  ])('lets through: %s', (text) => {
    expect(assertsWorkspaceQuantity(text)).toBe(false);
  });

  it('judges per SENTENCE, so one safe number does not excuse a fabricated one', () => {
    const mixed = 'I can help with 2 things. There are 50 companies in the database.';
    expect(assertsWorkspaceQuantity(mixed)).toBe(true);
  });

  it('is not fooled by the model stating the rule it just broke', () => {
    // The production transcript's second reply: the correct rule, said
    // immediately after breaking it. It is a claim about nothing and must pass.
    expect(
      assertsWorkspaceQuantity(
        'I apologize for the incorrect information. I cannot provide an exact count of the companies without accessing the relevant database.',
      ),
    ).toBe(false);
  });

  it('handles an empty answer without deciding anything', () => {
    expect(assertsWorkspaceQuantity('')).toBe(false);
  });
});
