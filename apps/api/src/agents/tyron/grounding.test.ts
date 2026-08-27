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

/**
 * #405 — a confident ZERO about a database that does not exist.
 *
 * Asked "How many archived deals are there?" against a workspace with no deals
 * database, Tyron answered "There are no archived deals in the database." Zero
 * tool calls, no numeral, so the #401 detector let it straight through.
 *
 * A wrong count invites doubt. A confident zero does not — it reads as a clean
 * result, so nobody goes looking. EMPTY and ABSENT collapsed into one sentence,
 * and the user walks away believing they have a deals database.
 */
describe('#405 empty is not the same as absent', () => {
  it('catches the exact sentence that shipped on production', () => {
    expect(assertsWorkspaceQuantity('There are no archived deals in the database.')).toBe(true);
  });

  it.each([
    'There are no records matching that.',
    'You have none in that database.',
    'There are zero rows in the table.',
    'Nothing in your workspace matches.',
    "There aren't any records like that.",
  ])('withholds an ungrounded zero: %s', (text) => {
    expect(assertsWorkspaceQuantity(text)).toBe(true);
  });

  it('a GENUINE zero still reads as a genuine zero once it is grounded', () => {
    /*
     * The AC insists both directions are tested: fixing one by breaking the
     * other is not a fix.
     *
     * This detector only ever runs on a turn that called NO tools — the loop
     * checks `toolCallsThisTurn === 0` first — so an empty Contacts-v1 answered
     * after a real query passes through untouched. What the detector must not do
     * is decide the sentence is innocent on its own, because ungrounded it is
     * the #405 bug verbatim.
     */
    expect(assertsWorkspaceQuantity('There are no records in Contacts-v1.')).toBe(true);
  });

  it('still lets an ordinary "no" through when it is not about data', () => {
    // Over-firing remains the other failure. "No" is a common English word and
    // most uses of it are not claims about a workspace.
    expect(assertsWorkspaceQuantity('No, I cannot do that.')).toBe(false);
    expect(assertsWorkspaceQuantity('There is no way to do that here.')).toBe(false);
    expect(assertsWorkspaceQuantity('No problem.')).toBe(false);
  });

  it('a question about which database is still the right answer, not an offence', () => {
    expect(assertsWorkspaceQuantity('I see no deals database — did you mean Companies-v1?')).toBe(false);
  });
});
