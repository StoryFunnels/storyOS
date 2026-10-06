import { describe, expect, it } from 'vitest';
import { REMOVED_MEMBER_LABEL, formatActivityValue } from './activity-format';

const names: Record<string, string> = { u1: 'Ievgen Krasovytskyi', u2: 'Dara' };
const name = (id: string) => names[id];

describe('formatActivityValue (#806)', () => {
  it('shows a person field as a NAME, never the id', () => {
    expect(formatActivityValue('u1', 'user', name)).toBe('Ievgen Krasovytskyi');
    expect(formatActivityValue(['u1', 'u2'], 'user', name)).toBe('Ievgen Krasovytskyi, Dara');
  });

  it('resolves the audit person types the same way', () => {
    expect(formatActivityValue('u2', 'created_by', name)).toBe('Dara');
    expect(formatActivityValue('u2', 'updated_by', name)).toBe('Dara');
  });

  it('a member who has since been removed resolves to the shared fallback, not the id', () => {
    const out = formatActivityValue('gone-id', 'user', name);
    expect(out).toBe(REMOVED_MEMBER_LABEL);
    expect(out).not.toContain('gone-id');
  });

  it('empty stays "empty", including inside a list', () => {
    expect(formatActivityValue(null, 'user', name)).toBe('empty');
    expect(formatActivityValue(undefined, undefined, name)).toBe('empty');
  });

  // What the type test must KEEP: a text value that happens to look like a member id is not a member.
  it('leaves every non-person type exactly as the API sent it', () => {
    expect(formatActivityValue('u1', 'text', name)).toBe('u1');
    expect(formatActivityValue('Done', 'select', name)).toBe('Done');
    expect(formatActivityValue(42, 'number', name)).toBe('42');
    expect(formatActivityValue(true, 'checkbox', name)).toBe('true');
    expect(formatActivityValue('u1', undefined, name)).toBe('u1'); // field unknown (e.g. deleted): never guess
  });
});
