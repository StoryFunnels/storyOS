import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ConsentCard, consentTitle, defaultWorkspaceId } from './consent-card';
import type { ConsentView } from './consent-card';

const request = {
  client_name: 'Claude',
  redirect_host: 'claude.ai',
  scopes: [{ id: 'openid', label: 'Know who you are' }],
  workspaces: [{ id: 'w1', name: 'Acme Studio' }, { id: 'w2', name: 'Side project' }],
  access_options: ['read', 'write'] as ('read' | 'write')[],
};
const one = { ...request, workspaces: [{ id: 'w1', name: 'Acme Studio' }] };

const ready = (over: Partial<Extract<ConsentView, { kind: 'ready' }>> = {}): ConsentView => ({
  kind: 'ready',
  request,
  workspaceId: null,
  access: 'read',
  busy: null,
  ...over,
});
const html = (view: ConsentView) =>
  renderToStaticMarkup(createElement(ConsentCard, { view, onDecide: () => {}, onChange: () => {}, onSwitchAccount: () => {} }));

describe('the consent screen states (#1030)', () => {
  it('ready: names the client and the host, offers every workspace and both access levels, with Allow and Deny', () => {
    const out = html(ready());
    expect(out).toContain('Claude');
    expect(out).toContain('claude.ai');
    expect(out).toContain('Acme Studio');
    expect(out).toContain('Side project');
    expect(out).toContain('Choose a workspace');
    expect(out).toContain('Read only');
    expect(out).toContain('Read and write');
    expect(out).toContain('Know who you are');
    expect(out).toContain('>Allow<');
    expect(out).toContain('>Deny<');
    expect(out).toContain('stop working until they reconnect');
    expect(consentTitle(ready())).toBe('Allow Claude to connect?');
  });

  it('with several workspaces and none chosen, Allow is disabled and says why; Deny is not', () => {
    const out = html(ready());
    expect(out).toContain('Choose a workspace to allow.');
    const allow = out.match(/<button[^>]*>Allow<\/button>/)![0];
    const deny = out.match(/<button[^>]*>Deny<\/button>/)![0];
    expect(allow).toContain('disabled=""');
    expect(deny).not.toContain('disabled=""');
  });

  it('once a workspace is chosen, Allow is enabled and the choice is the selected option', () => {
    const out = html(ready({ workspaceId: 'w2' }));
    expect(out.match(/<button[^>]*>Allow<\/button>/)![0]).not.toContain('disabled=""');
    expect(out).toMatch(/<option value="w2" selected/);
    expect(out).not.toContain('Choose a workspace to allow.');
  });

  it('exactly one workspace is shown as a fixed row (no chooser) and preselected; several are never preselected', () => {
    expect(defaultWorkspaceId(one)).toBe('w1');
    expect(defaultWorkspaceId(request)).toBeNull();
    const out = html(ready({ request: one, workspaceId: 'w1' }));
    expect(out).not.toContain('<select');
    expect(out).toContain('Acme Studio');
  });

  it('access defaults to read: that radio is checked, the other is not', () => {
    const out = html(ready());
    const radios = out.match(/<input[^>]*type="radio"[^>]*>/g)!;
    expect(radios).toHaveLength(2);
    expect(radios[0]).toContain('checked');
    expect(radios[1]).not.toContain('checked');
    expect(html(ready({ access: 'write' })).match(/<input[^>]*type="radio"[^>]*>/g)![1]).toContain('checked');
  });

  it('ready: every control is disabled once a decision is in flight, and the button says which', () => {
    const out = html(ready({ workspaceId: 'w1', busy: 'allow' }));
    expect(out).toContain('Allowing…');
    expect(out).toMatch(/<fieldset[^>]*disabled=""/);
    expect(out.match(/<button[^>]*disabled=""/g)).toHaveLength(2);
    expect(html(ready({ workspaceId: 'w1', busy: 'deny' }))).toContain('Cancelling…');
  });

  it('loading and redirecting are announced as status, with no decision buttons', () => {
    for (const view of [{ kind: 'loading' }, { kind: 'redirecting', decision: 'allow' }, { kind: 'redirecting', decision: 'deny' }] as ConsentView[]) {
      const out = html(view);
      expect(out).toContain('role="status"');
      expect(out).not.toContain('>Allow<');
      expect(out).not.toContain('>Deny<');
    }
    expect(html({ kind: 'redirecting', decision: 'deny' })).toContain('Cancelled');
  });

  it('every failure says nothing was granted where it applies, offers the way out and never Allow', () => {
    for (const code of ['expired', 'invalid', 'no_workspace', 'not_a_session', 'unavailable'] as const) {
      const out = html({ kind: 'failed', code });
      expect(out).toContain('role="alert"');
      expect(out).toContain('Go to my workspaces');
      expect(out).not.toContain('>Allow<');
    }
  });

  it('an expired or already-answered request shows the server sentence', () => {
    const out = html({ kind: 'failed', code: 'expired', message: 'This authorization request was already answered.' });
    expect(out).toContain('already answered');
  });

  it('no workspace: says so and offers another account; a token session offers to sign in again', () => {
    const none = html({ kind: 'failed', code: 'no_workspace' });
    expect(none).toContain('not a member of any workspace');
    expect(none).toContain('Use another account');
    expect(html({ kind: 'failed', code: 'not_a_session' })).toContain('Sign in again');
  });

  it('a client name that looks like markup is escaped', () => {
    const out = html(ready({ request: { ...request, client_name: '<img src=x onerror=alert(1)>' } }));
    expect(out).not.toContain('<img src=x');
    expect(out).toContain('&lt;img');
  });
});

describe('the consent page', () => {
  const page = readFileSync(join(__dirname, '../../app/oauth/consent/page.tsx'), 'utf8');
  it('talks to the server only through lib/oauth-consent, so the contract lives in one file', () => {
    expect(page).not.toMatch(/\bfetch\(|api\.(GET|POST)/);
    expect(page).toMatch(/from '@\/lib\/oauth-consent'/);
  });

  it('reads the consent_code better-auth sends, and sends a deny with no workspace', () => {
    expect(page).toContain("get('consent_code')");
    const lib = readFileSync(join(__dirname, '../../lib/oauth-consent.ts'), 'utf8');
    expect(lib).toMatch(/decision === 'allow' \? \{ workspace_id/);
  });
});
