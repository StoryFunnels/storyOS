import { afterEach, describe, expect, it, vi } from 'vitest';
import { decideConsent, readConsent, readDecision, redirectTarget } from './oauth-consent';

const ready = {
  client_name: 'Claude',
  redirect_host: 'claude.ai',
  scopes: [{ id: 'openid', label: 'Know who you are' }],
  workspaces: [{ id: 'w1', name: 'Acme' }, { id: 'w2', name: 'Side project' }],
};
const envelope = (code: string, message: string) => ({ error: { code, message } });

describe('readConsent (#1030)', () => {
  it('reads a complete request, with the workspaces to choose from and no access level', () => {
    expect(readConsent(200, ready)).toEqual({ kind: 'ready', request: ready });
  });

  // An API that still sends the old field is not an error: it is ignored, and never reaches the screen.
  it('ignores an access_options field an older server may still send', () => {
    const r = readConsent(200, { ...ready, access_options: ['read', 'write'] });
    expect(r.kind === 'ready' && 'access_options' in r.request).toBe(false);
  });

  // The danger is a 200 the screen cannot read being drawn as an Allow button for something unnamed.
  it.each([
    ['no client name', { ...ready, client_name: '' }],
    ['no redirect host', { ...ready, redirect_host: undefined }],
    ['workspaces not a list', { ...ready, workspaces: 'w1' }],
    ['a workspace without a name', { ...ready, workspaces: [{ id: 'w1' }] }],
    ['scopes not a list', { ...ready, scopes: 'read' }],
    ['a scope without a label', { ...ready, scopes: [{ id: 'openid' }] }],
    ['not an object', 'ok'],
    ['null', null],
  ])('a 200 with %s is never shown as ready', (_n, body) => {
    expect(readConsent(200, body)).toEqual({ kind: 'failed', code: 'invalid' });
  });

  it('a person in no workspace is a dead end with its own wording, not an empty chooser', () => {
    expect(readConsent(200, { ...ready, workspaces: [] })).toEqual({ kind: 'failed', code: 'no_workspace' });
  });

  it('maps the server statuses: 410 keeps the server sentence, 403 is not-a-session, 404 and the rest are invalid', () => {
    expect(readConsent(410, envelope('gone', 'This authorization request was already answered.'))).toEqual({
      kind: 'failed',
      code: 'expired',
      message: 'This authorization request was already answered.',
    });
    expect(readConsent(403, envelope('forbidden', 'x'))).toEqual({ kind: 'failed', code: 'not_a_session' });
    for (const [status, body] of [[404, envelope('not_found', 'x')], [422, null], [400, {}]] as const) {
      expect(readConsent(status, body)).toEqual({ kind: 'failed', code: 'invalid' });
    }
  });

  it('a server error is "unavailable", so the screen says nothing was connected and to retry', () => {
    expect(readConsent(502, null)).toEqual({ kind: 'failed', code: 'unavailable' });
  });
});

describe('readDecision (#1030)', () => {
  it.each([
    'https://claude.ai/cb?code=x&state=y',
    'cursor://anysphere.cursor-mcp/oauth/callback?code=x&state=y',
    'vscode://ms-vscode.mcp/callback?code=x',
    'http://127.0.0.1:6274/oauth/callback?code=x',
    'http://[::1]:8080/cb?code=x',
    'http://localhost:3000/cb?error=access_denied&state=y',
  ])('follows a redirect the server sent: %s', (url) => {
    expect(readDecision(200, { redirect_url: url })).toEqual({ kind: 'redirect', url });
  });

  // The page does window.location.assign(url): a javascript: URL here would run on the app's own origin.
  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    ' javascript:alert(1)',
    'java\tscript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'blob:https://claude.ai/3f2a',
    'about:blank',
    '//evil.example/cb',
    '',
  ])('refuses the redirect %j', (url) => {
    expect(readDecision(200, { redirect_url: url })).toEqual({ kind: 'failed', code: 'invalid' });
  });

  it('refuses a missing or non-string redirect', () => {
    expect(readDecision(200, {})).toEqual({ kind: 'failed', code: 'invalid' });
    expect(readDecision(200, { redirect_url: 42 })).toEqual({ kind: 'failed', code: 'invalid' });
  });

  it('does not follow a redirect that came with a failure status', () => {
    expect(readDecision(410, { error: { code: 'gone', message: 'expired' }, redirect_url: 'https://claude.ai/cb' })).toEqual({
      kind: 'failed',
      code: 'expired',
      message: 'expired',
    });
  });
});

describe('redirectTarget', () => {
  it('refuses the schemes that run or expose content, and anything that does not parse', () => {
    expect(redirectTarget('https://a.example/x')).toBe('https://a.example/x');
    expect(redirectTarget('cursor://x/y')).toBe('cursor://x/y');
    expect(redirectTarget('javascript:1')).toBeNull();
    expect(redirectTarget('not a url')).toBeNull();
  });
});

describe('what Allow sends (#1079)', () => {
  const sent: unknown[] = [];
  afterEach(() => {
    sent.length = 0;
    vi.unstubAllGlobals();
  });
  const stub = () =>
    vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
      sent.push(JSON.parse(init.body));
      return { status: 200, json: async () => ({ redirect_url: 'https://claude.ai/cb' }) };
    });

  it('allow for ALL workspaces names none: the field is omitted, and there is no access level', async () => {
    stub();
    await decideConsent({ consentCode: 'code-123456', decision: 'allow' });
    expect(sent[0]).toEqual({ consent_code: 'code-123456', decision: 'allow' });
  });

  it('allow for ONE workspace names it, and still no access level', async () => {
    stub();
    await decideConsent({ consentCode: 'code-123456', decision: 'allow', workspaceId: 'w2' });
    expect(sent[0]).toEqual({ consent_code: 'code-123456', decision: 'allow', workspace_id: 'w2' });
  });

  it('a deny names no workspace, even if one was passed', async () => {
    stub();
    await decideConsent({ consentCode: 'code-123456', decision: 'deny', workspaceId: 'w2' });
    expect(sent[0]).toEqual({ consent_code: 'code-123456', decision: 'deny' });
  });

  it('no request this layer builds ever carries an access level', async () => {
    stub();
    await decideConsent({ consentCode: 'code-123456', decision: 'allow', workspaceId: 'w1' });
    await decideConsent({ consentCode: 'code-123456', decision: 'allow' });
    expect(JSON.stringify(sent)).not.toMatch(/access/);
  });
});
