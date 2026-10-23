import { describe, expect, it } from 'vitest';
import { httpTarget, readConsent, readDecision } from './oauth-consent';

const ready = {
  client_name: 'Claude',
  redirect_host: 'claude.ai',
  scopes: [{ id: 'read', label: 'Read your records' }],
  workspace: { id: 'ws1', name: 'Acme' },
};

describe('readConsent (#1030)', () => {
  it('reads a complete request', () => {
    expect(readConsent(200, ready)).toEqual({ kind: 'ready', request: ready });
  });

  it('keeps a request with no scopes — the screen says so rather than refusing it', () => {
    const r = readConsent(200, { ...ready, scopes: [] });
    expect(r.kind).toBe('ready');
  });

  // The danger is a 200 the screen cannot read being drawn as an empty Allow button.
  it.each([
    ['no client name', { ...ready, client_name: '' }],
    ['no workspace', { ...ready, workspace: undefined }],
    ['scopes not a list', { ...ready, scopes: 'read' }],
    ['a scope without a label', { ...ready, scopes: [{ id: 'read' }] }],
    ['not an object', 'ok'],
    ['null', null],
  ])('a 200 with %s is never shown as ready', (_n, body) => {
    expect(readConsent(200, body)).toEqual({ kind: 'failed', code: 'invalid' });
  });

  it('maps the known failure codes and carries the workspace name for not_member', () => {
    expect(readConsent(410, { code: 'expired' })).toEqual({ kind: 'failed', code: 'expired', workspaceName: undefined });
    expect(readConsent(403, { code: 'not_member', workspace: { name: 'Acme' } })).toEqual({
      kind: 'failed',
      code: 'not_member',
      workspaceName: 'Acme',
    });
  });

  it('an unknown code, a bare 404 or no body is "invalid", never ready', () => {
    for (const [status, body] of [[400, { code: 'weird' }], [404, null], [401, {}]] as const) {
      expect(readConsent(status, body)).toMatchObject({ kind: 'failed', code: 'invalid' });
    }
  });

  it('a server error is "unavailable", so the screen says nothing was connected and to retry', () => {
    expect(readConsent(502, null)).toMatchObject({ kind: 'failed', code: 'unavailable' });
  });
});

describe('readDecision (#1030)', () => {
  it('follows an https or http redirect', () => {
    expect(readDecision(200, { redirect_url: 'https://claude.ai/cb?code=x&state=y' })).toEqual({
      kind: 'redirect',
      url: 'https://claude.ai/cb?code=x&state=y',
    });
    expect(readDecision(200, { redirect_url: 'http://localhost:6274/oauth/callback?code=x' }).kind).toBe('redirect');
  });

  // The page does window.location.assign(url): a javascript: URL here would run on the app's own origin.
  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    ' javascript:alert(1)',
    'java\tscript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
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
    expect(readDecision(410, { code: 'expired', redirect_url: 'https://claude.ai/cb' })).toEqual({
      kind: 'failed',
      code: 'expired',
    });
  });
});

describe('httpTarget', () => {
  it('passes http(s) and nothing else', () => {
    expect(httpTarget('https://a.example/x')).toBe('https://a.example/x');
    expect(httpTarget('ftp://a.example')).toBeNull();
    expect(httpTarget('not a url')).toBeNull();
  });
});
