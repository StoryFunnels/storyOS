import { describe, expect, it } from 'vitest';
import { choiceInstruction, matchChoice } from './ai-field-choice';

const OPTIONS = ['Enterprise', 'SMB', 'Mid Market'];

describe('matchChoice (#1109)', () => {
  it('returns the option label for an exact answer', () => {
    expect(matchChoice('SMB', OPTIONS)).toBe('SMB');
  });

  it.each([
    ['enterprise', 'Enterprise'],
    ['  SMB \n', 'SMB'],
    ['"Enterprise"', 'Enterprise'],
    ["'smb'", 'SMB'],
    ['Enterprise.', 'Enterprise'],
    ['**Mid Market**', 'Mid Market'],
    ['`mid market`!', 'Mid Market'],
  ])('tolerates case, whitespace, quotes and trailing punctuation: %j', (answer, label) => {
    expect(matchChoice(answer, OPTIONS)).toBe(label);
  });

  it.each([['Startup'], [''], ['   '], ['Enterprise or SMB'], ['{"answer":"SMB"}'], ['Mid']])(
    'refuses what is not one of the options: %j',
    (answer) => {
      expect(matchChoice(answer, OPTIONS)).toBeNull();
    },
  );

  it('refuses an answer that is ambiguous between two options', () => {
    expect(matchChoice('a', ['A', 'a.'])).toBeNull();
    expect(matchChoice('A', ['A', 'a.'])).toBe('A'); // an exact hit still wins
  });

  it('the instruction lists every option', () => {
    const text = choiceInstruction(OPTIONS);
    for (const o of OPTIONS) expect(text).toContain(`"${o}"`);
  });
});
