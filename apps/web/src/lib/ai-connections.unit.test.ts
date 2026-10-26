import { describe, expect, it } from 'vitest';
import { connectionWords, lastUsedText } from './ai-connections';

const date = (v: unknown) => `<${String(v).slice(0, 10)}>`;

describe('the words for a connection (#1030, #1079)', () => {
  it('a connection that reaches every workspace says so, in the row and in the confirmation, with no access wording', () => {
    const w = connectionWords({ kind: 'oauth', client_name: 'Claude', reaches: 'all_workspaces', approved: null });
    expect(w.reaches).toBe('All your workspaces');
    expect(w.confirmTitle).toBe('Disconnect Claude?');
    expect(w.confirmMessage).toContain('all your workspaces');
    expect(w.confirmMessage).toContain('ask to connect again');
    expect(JSON.stringify(w)).not.toMatch(/read only|read and write|access level/i);
  });

  it('one workspace names it, and never a level', () => {
    const w = connectionWords({ kind: 'oauth', client_name: 'Claude', reaches: 'one_workspace', approved: { workspace_id: 'w1', workspace_name: 'Acme' } });
    expect(w.reaches).toBe('Acme only');
    expect(w.confirmMessage).toContain('loses access to Acme');
    expect(JSON.stringify(w)).not.toMatch(/read only|read and write/i);
  });

  it('a workspace the server cannot name is still one workspace, never a guess at which', () => {
    const w = connectionWords({ kind: 'oauth', client_name: 'Claude', reaches: 'one_workspace', approved: { workspace_id: 'w1', workspace_name: null } });
    expect(w.reaches).toBe('One workspace only');
    expect(w.confirmMessage).toContain('its workspace');
  });

  // Refused by the server; calling it a workspace would claim access it does not have.
  it('a connection whose approval no longer applies says "Reconnect needed", never a workspace', () => {
    const w = connectionWords({ kind: 'oauth', client_name: 'Cursor', reaches: 'needs_reconnect', approved: null });
    expect(w.reaches).toBe('Reconnect needed');
    expect(w.reaches).not.toMatch(/all|workspaces/i);
    expect(w.confirmMessage).toContain('stops working until it is reconnected');
  });

  it('a "one_workspace" answer with nothing approved attached is not trusted, and a shape it does not know is not guessed at', () => {
    expect(connectionWords({ kind: 'oauth', client_name: 'X', reaches: 'one_workspace', approved: null }).reaches).toBe('Access not reported');
    expect(connectionWords({ kind: 'oauth', client_name: 'X', reaches: 'something_new' as never }).reaches).toBe('Access not reported');
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
