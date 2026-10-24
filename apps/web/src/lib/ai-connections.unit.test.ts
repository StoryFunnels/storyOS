import { describe, expect, it } from 'vitest';
import { connectionWords, lastUsedText } from './ai-connections';

const date = (v: unknown) => `<${String(v).slice(0, 10)}>`;

describe('the words for a connection (#1030)', () => {
  const bound = { id: 'w1', name: 'Acme' };

  it('an OAuth client bound to one workspace names it and the level, in the row and in the confirmation', () => {
    const w = connectionWords({ kind: 'oauth', client_name: 'Claude', reaches: 'one_workspace', workspace: bound, access: 'write' });
    expect(w.reaches).toBe('Acme only · Read and write');
    expect(w.confirmTitle).toBe('Disconnect Claude?');
    expect(w.confirmMessage).toContain('loses access to Acme');
    expect(w.confirmMessage).toContain('ask to connect again');
    expect(connectionWords({ kind: 'oauth', client_name: 'Claude', reaches: 'one_workspace', workspace: bound, access: 'read' }).reaches).toBe('Acme only · Read only');
  });

  // Legacy connections are refused by the server; calling them "all workspaces" would claim access they do not have.
  it('an OAuth connection with no usable approval says "Reconnect needed", never a workspace', () => {
    const w = connectionWords({ kind: 'oauth', client_name: 'Cursor', reaches: 'reconnect_needed', workspace: null, access: null });
    expect(w.reaches).toBe('Reconnect needed');
    expect(w.reaches).not.toMatch(/all|workspaces/i);
    expect(w.confirmMessage).toContain('no longer works');
  });

  it('a "one_workspace" answer with no workspace attached is not trusted: it reads as reconnect needed', () => {
    expect(connectionWords({ kind: 'oauth', client_name: 'X', reaches: 'one_workspace', workspace: null, access: 'read' }).reaches).toBe('Reconnect needed');
  });

  it('a token is one workspace, and its confirmation says it stops working', () => {
    const w = connectionWords({ kind: 'token', client_name: 'Cursor key', reaches: 'this_workspace', workspace: null, access: null });
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
