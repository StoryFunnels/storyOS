import { describe, expect, it } from 'vitest';
import { connectionWords, lastUsedText } from './ai-connections';

const date = (v: unknown) => `<${String(v).slice(0, 10)}>`;

describe('the words for a connection (#1030)', () => {
  it('an OAuth client reaches every workspace and says so, in the row and in the confirmation', () => {
    const w = connectionWords({ kind: 'oauth', client_name: 'Claude', reaches: 'all_your_workspaces' });
    expect(w.reaches).toBe('All your workspaces');
    expect(w.confirmTitle).toBe('Disconnect Claude?');
    expect(w.confirmMessage).toContain('every workspace you are in');
    expect(w.confirmMessage).toContain('ask to connect again');
  });

  it('a token is one workspace, and its confirmation says it stops working', () => {
    const w = connectionWords({ kind: 'token', client_name: 'Cursor key', reaches: 'this_workspace' });
    expect(w.reaches).toBe('This workspace only');
    expect(w.how).toBe('Personal access token');
    expect(w.confirmMessage).toContain('stops working');
  });
});

describe('last used (#1030)', () => {
  it('prints the date when there is one', () => {
    expect(lastUsedText({ kind: 'token', last_used_at: '2026-10-20T10:00:00Z' }, date)).toBe('Last used <2026-10-20>');
  });

  // Null is two different facts: a token records every use, OAuth records none. "Never used" for an OAuth client would be a confident falsehood.
  it('null is "never used" for a token but "not recorded" for OAuth', () => {
    expect(lastUsedText({ kind: 'token', last_used_at: null }, date)).toBe('Never used');
    expect(lastUsedText({ kind: 'oauth', last_used_at: null }, date)).toBe('Last use not recorded');
  });
});
