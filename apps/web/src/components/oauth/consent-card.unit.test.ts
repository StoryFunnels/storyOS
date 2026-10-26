import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ConsentCard, applyLoaded, canAllow, consentTitle, defaultWorkspaceId, readyView } from './consent-card';
import type { ConsentView } from './consent-card';

const request = {
  client_name: 'Claude',
  redirect_host: 'claude.ai',
  scopes: [{ id: 'openid', label: 'Know who you are' }],
  workspaces: [{ id: 'w1', name: 'Acme Studio' }, { id: 'w2', name: 'Side project' }],
};
const one = { ...request, workspaces: [{ id: 'w1', name: 'Acme Studio' }] };

type Ready = Extract<ConsentView, { kind: 'ready' }>;
const ready = (over: Partial<Ready> = {}): Ready => ({ ...(readyView(request) as Ready), ...over });
const html = (view: ConsentView) =>
  renderToStaticMarkup(createElement(ConsentCard, { view, onDecide: () => {}, onChange: () => {}, onSwitchAccount: () => {} }));

describe('the consent screen states (#1030, #1079)', () => {
  it('starts on ALL my workspaces, with Allow enabled and no workspace chosen', () => {
    const v = readyView(request) as Ready;
    expect(v).toMatchObject({ scope: 'all', workspaceId: null, busy: null });
    expect(canAllow(v)).toBe(true);
    const out = html(v);
    expect(out).toContain('All my workspaces');
    expect(out).toContain('One workspace');
    expect(out).toContain('Including any you join later');
    expect(out).toMatch(/<input[^>]*name="consent-scope"[^>]*checked=""[^>]*>[\s\S]*All my workspaces/);
    expect(out).not.toContain('<select'); // the picker only shows once "One workspace" is chosen
    expect(out).toContain('>Allow<');
    expect(out).toContain('>Deny<');
    expect(consentTitle(v)).toBe('Allow Claude to connect?');
  });

  // Ievgen's decision: no read-only level. Nothing on the screen offers, defaults or mentions one.
  it('has no access level anywhere: no radios for it, no "Read only", no "Read and write"', () => {
    for (const view of [ready(), ready({ scope: 'one', workspaceId: 'w2' }), ready({ busy: 'allow' })]) {
      const out = html(view);
      expect(out).not.toMatch(/consent-access|Read only|Read and write|read-only|What it can do/);
    }
    expect(html(ready())).toContain('To limit which tools it may use, switch them off in Claude.');
  });

  it('with ONE WORKSPACE chosen the picker shows, Allow needs a workspace, and the choice is the selected option', () => {
    const none = ready({ scope: 'one' });
    expect(canAllow(none)).toBe(false);
    const out = html(none);
    expect(out).toContain('Choose a workspace');
    expect(out).toContain('Choose a workspace to allow.');
    expect(out.match(/<button[^>]*>Allow<\/button>/)![0]).toContain('disabled=""');
    const chosen = ready({ scope: 'one', workspaceId: 'w2' });
    expect(canAllow(chosen)).toBe(true);
    const picked = html(chosen);
    expect(picked).toMatch(/<option value="w2" selected/);
    expect(picked.match(/<button[^>]*>Allow<\/button>/)![0]).not.toContain('disabled=""');
  });

  it('Deny is never blocked by the workspace choice', () => {
    const out = html(ready({ scope: 'one' }));
    expect(out.match(/<button[^>]*>Deny<\/button>/)![0]).not.toContain('disabled=""');
  });

  it('exactly one workspace is preselected for "One workspace" and named on the first row; several never are', () => {
    expect(defaultWorkspaceId(one)).toBe('w1');
    expect(defaultWorkspaceId(request)).toBeNull();
    const out = html(readyView(one));
    expect(out).toContain('All my workspaces (Acme Studio)');
    const chosen = html({ ...(readyView(one) as Ready), scope: 'one' });
    expect(chosen).not.toContain('<select');
    expect(chosen).toContain('Acme Studio');
  });

  it('every control is disabled once a decision is in flight, and the button says which', () => {
    const out = html(ready({ busy: 'allow' }));
    expect(out).toContain('Allowing…');
    expect(out).toMatch(/<fieldset[^>]*disabled=""/);
    expect(out.match(/<button[^>]*disabled=""/g)).toHaveLength(2);
    expect(html(ready({ busy: 'deny' }))).toContain('Cancelling…');
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

  it('every failure offers the way out and never Allow; an answered request shows the server sentence', () => {
    for (const code of ['expired', 'invalid', 'no_workspace', 'not_a_session', 'unavailable'] as const) {
      const out = html({ kind: 'failed', code });
      expect(out).toContain('role="alert"');
      expect(out).toContain('Go to my workspaces');
      expect(out).not.toContain('>Allow<');
    }
    expect(html({ kind: 'failed', code: 'expired', message: 'This authorization request was already answered.' })).toContain('already answered');
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

// The bug Ievgen hit in production: a choice made on the screen was wiped. The screen is now set by the FIRST load only.
describe('nothing but the person changes the screen after it loads (#1079)', () => {
  const loaded = { kind: 'ready' as const, request };

  it('the first load sets the screen, to All workspaces', () => {
    expect(applyLoaded({ kind: 'loading' }, loaded)).toMatchObject({ kind: 'ready', scope: 'all', workspaceId: null });
  });

  it('a second load (a session refetch re-ran it) leaves a chosen workspace untouched', () => {
    const chosen = ready({ scope: 'one', workspaceId: 'w2' });
    expect(applyLoaded(chosen, loaded)).toBe(chosen);
  });

  it.each([
    ['in flight', ready({ scope: 'one', workspaceId: 'w2', busy: 'allow' as const })],
    ['redirecting', { kind: 'redirecting', decision: 'allow' } as ConsentView],
    ['failed', { kind: 'failed', code: 'expired' } as ConsentView],
  ])('and one that arrives while %s changes nothing', (_n, current) => {
    expect(applyLoaded(current, loaded)).toBe(current);
  });

  it('a failed first load shows the failure', () => {
    expect(applyLoaded({ kind: 'loading' }, { kind: 'failed', code: 'unavailable' })).toEqual({ kind: 'failed', code: 'unavailable' });
  });
});

describe('the consent page (#1079)', () => {
  const page = readFileSync(join(__dirname, '../../app/oauth/consent/page.tsx'), 'utf8');

  it('talks to the server only through lib/oauth-consent, so the contract lives in one file', () => {
    expect(page).not.toMatch(/\bfetch\(|api\.(GET|POST)/);
    expect(page).toMatch(/from '@\/lib\/oauth-consent'/);
    expect(page).toContain("get('consent_code')");
  });

  // The cause found live: the load effect depended on the whole session object, which a refetch on window focus replaces.
  it('the load effect depends on whether someone is signed in, never on the session object', () => {
    const effect = page.slice(page.indexOf('useEffect(() => {\n    if (isPending) return;'), page.indexOf('const change ='));
    expect(effect).toContain('[isPending, signedIn, code, router]');
    expect(effect).not.toMatch(/\[[^\]]*\bsession\b[^\]]*\]/);
    expect(effect).toContain('applyLoaded');
  });

  it('allow sends a workspace only when "One workspace" was chosen, and no access level', () => {
    expect(page).toContain("ready.scope === 'one'");
    expect(page).not.toMatch(/access/);
  });
});
