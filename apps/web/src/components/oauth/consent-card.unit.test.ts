import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ConsentCard, consentTitle } from './consent-card';
import type { ConsentView } from './consent-card';

const request = {
  client_name: 'Claude',
  redirect_host: 'claude.ai',
  scopes: [
    { id: 'read', label: 'Read records in this workspace' },
    { id: 'write', label: 'Create and edit records' },
  ],
  workspace: { id: 'ws1', name: 'Acme Studio' },
};

const html = (view: ConsentView) =>
  renderToStaticMarkup(createElement(ConsentCard, { view, onDecide: () => {}, onSwitchAccount: () => {} }));

describe('the consent screen states (#1030)', () => {
  it('ready: names the client, the host it returns to, the workspace and every scope, with Allow and Deny', () => {
    const out = html({ kind: 'ready', request, busy: null });
    expect(out).toContain('Claude');
    expect(out).toContain('claude.ai');
    expect(out).toContain('Acme Studio');
    expect(out).toContain('Read records in this workspace');
    expect(out).toContain('Create and edit records');
    expect(out).toContain('>Allow<');
    expect(out).toContain('>Deny<');
    expect(consentTitle({ kind: 'ready', request, busy: null })).toBe('Allow Claude to connect?');
  });

  it('ready: both buttons are disabled once a decision is in flight, and say which one', () => {
    const out = html({ kind: 'ready', request, busy: 'allow' });
    expect(out).toContain('Allowing…');
    expect(out.match(/disabled=""/g)).toHaveLength(2);
    expect(html({ kind: 'ready', request, busy: 'deny' })).toContain('Cancelling…');
  });

  it('ready: no scopes is stated, not drawn as an empty list', () => {
    expect(html({ kind: 'ready', request: { ...request, scopes: [] }, busy: null })).toContain('Nothing beyond signing in as you');
  });

  it('ready without a redirect host does not invent one', () => {
    expect(html({ kind: 'ready', request: { ...request, redirect_host: undefined }, busy: null })).not.toContain('send you back to');
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

  it('expired and invalid say nothing was granted and offer the way out, never Allow', () => {
    for (const code of ['expired', 'invalid', 'unavailable'] as const) {
      const out = html({ kind: 'failed', code });
      expect(out).toContain('role="alert"');
      expect(out).toContain('Go to my workspaces');
      expect(out).not.toContain('>Allow<');
    }
    expect(html({ kind: 'failed', code: 'expired' })).toContain('expired');
  });

  it('not a member: names the workspace and offers a different account', () => {
    const out = html({ kind: 'failed', code: 'not_member', workspaceName: 'Acme Studio' });
    expect(out).toContain('You are not a member of Acme Studio.');
    expect(out).toContain('Use another account');
    expect(html({ kind: 'failed', code: 'not_member' })).toContain('the workspace this app asked for');
  });

  it('a client name that looks like markup is escaped', () => {
    const out = html({ kind: 'ready', request: { ...request, client_name: '<img src=x onerror=alert(1)>' }, busy: null });
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
});
