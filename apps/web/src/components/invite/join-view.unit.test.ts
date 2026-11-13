import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { JoinView, SignedOutForm } from './join-view';
import { joinModel } from '@/lib/invite-screen';
import type { JoinModel } from '@/lib/invite-screen';
import type { InviteDetails } from '@/lib/invite-api';

// Pinewood, made up.
const valid: InviteDetails = { status: 'valid', inviter_name: 'Maple Ridge', workspace_name: 'Pinewood Studio', workspace_logo_url: null, invited_email: 'new.hire@pinewood.example' };
const notFound: InviteDetails = { status: 'not_found', inviter_name: null, workspace_name: null, workspace_logo_url: null, invited_email: null };

const render = (model: JoinModel, signedIn = false, extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(JoinView, { model, signedIn, ...extra }));
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, ' ');

const formProps = {
  action: 'Join Pinewood Studio',
  invitedEmail: 'new.hire@pinewood.example',
  mode: 'new' as const,
  name: '',
  password: '',
  onName: () => undefined,
  onPassword: () => undefined,
  onSubmit: () => undefined,
  busy: false,
  error: null,
  forgotHref: '/reset?next=x',
};

describe('the Join screen draws every state (#1302)', () => {
  it('valid + new: inviter, workspace name and initial avatar, the email LOCKED, one Join action, and no create-workspace words', () => {
    const model = joinModel({ details: valid, session: { status: 'signed_out' } });
    const html = render(model, false, { signedOutForm: createElement(SignedOutForm, formProps) });
    const t = text(html);
    expect(t).toContain('Maple Ridge invited you to Pinewood Studio');
    expect(html).toContain('data-testid="invite-workspace"');
    expect(t).toContain('PS'); // the shared Avatar's initials: no logo, so the initial fallback
    expect(html).toMatch(/<input[^>]*id="invited-email"[^>]*readOnly=""|<input[^>]*readonly=""[^>]*id="invited-email"|<input[^>]*id="invited-email"[^>]*readonly/i);
    expect(html).toContain('value="new.hire@pinewood.example"');
    expect(t.match(/Join Pinewood Studio/g)).toHaveLength(1); // ONE action
    expect(html).toContain('type="submit"');
    expect(t).not.toMatch(/create (a |your )?workspace|new workspace|name your workspace/i);
  });
  it('a logo is drawn when the workspace has one', () => {
    const html = render(joinModel({ details: { ...valid, workspace_logo_url: 'https://cdn.pinewood.example/logo.png' }, session: { status: 'signed_out' } }), false);
    expect(html).toContain('https://cdn.pinewood.example/logo.png');
  });
  it('existing account: the form asks only for the password', () => {
    const t = text(renderToStaticMarkup(createElement(SignedOutForm, { ...formProps, mode: 'existing' })));
    expect(t).toContain('You already have a StoryOS account with this email');
    expect(t).not.toContain('Your name');
    expect(t).toContain('Forgot password');
  });
  it('a refusal is announced (role=alert)', () => {
    const html = renderToStaticMarkup(createElement(SignedOutForm, { ...formProps, error: 'That password does not match the account for this email.' }));
    expect(html).toMatch(/role="alert"[^>]*>That password does not match/);
  });
  it('signed in as the invited email: one button, no password, the email still locked', () => {
    const html = render(joinModel({ details: valid, session: { status: 'signed_in', email: 'New.Hire@pinewood.example' } }), true);
    expect(text(html).match(/Join Pinewood Studio/g)).toHaveLength(1);
    expect(html).not.toContain('type="password"');
    expect(html).toContain('id="invited-email"');
  });
  it('signed in as someone else: the mismatch message, Switch account, and no Join', () => {
    const t = text(render(joinModel({ details: valid, session: { status: 'signed_in', email: 'other@pinewood.example' } }), true));
    expect(t).toContain("This invite was sent to new.hire@pinewood.example. You’re signed in as other@pinewood.example.".replace('’', '’'));
    expect(t).toContain('Switch account');
    expect(t).not.toContain('Join Pinewood Studio');
  });
  for (const status of ['expired', 'used'] as const) {
    it(`${status}: says so, names the inviter, and has no Join button`, () => {
      const html = render(joinModel({ details: { ...valid, status }, session: { status: 'signed_out' } }), false);
      const t = text(html);
      expect(t).toContain(status === 'expired' ? 'This invite has expired' : 'This invite was already used');
      expect(t).toContain('Ask Maple Ridge for a new link.');
      expect(t).not.toContain('Join Pinewood Studio');
      expect(html).not.toContain('type="submit"');
      expect(html).not.toContain('type="password"');
    });
  }
  it('not found: the shared Quill page, generic wording, no inviter, no Join, no shell', () => {
    const html = render(joinModel({ details: notFound, session: { status: 'signed_out' } }), false);
    const t = text(html);
    expect(html).toContain('data-testid="not-found"');
    expect(t).toContain('This was an invite once.');
    expect(t).not.toContain('a page once');
    expect(t).toContain('This invite link no longer works');
    expect(t).toContain('Ask whoever invited you for a new link.');
    expect(t).not.toMatch(/Join |invited you to/);
    expect(html).not.toContain('<form');
    expect(html).not.toContain('/brand/mark.svg'); // AuthCard's mark: this page has no shell
    expect(html).toContain('href="https://storyos.dev"'); // signed out: no better action
  });
  it('not found, signed in: the better action is the person’s own workspaces', () => {
    const html = render(joinModel({ details: notFound, session: { status: 'signed_in', email: 'a@b.example' } }), true);
    expect(text(html)).toContain('Go to my workspaces');
    expect(html).not.toContain('storyos.dev');
  });
  it('loading and unavailable draw something honest and no Join', () => {
    expect(text(render({ kind: 'loading' }))).toContain('Checking your invite');
    const t = text(render(joinModel({ details: null, detailsFailed: true, session: { status: 'signed_out' } })));
    expect(t).toContain('We could not check this invite');
    expect(t).not.toContain('Join ');
  });
});

describe('the token is never drawn or logged, and the join path never reaches create-workspace (#1302)', () => {
  const src = fileURLToPath(new URL('../..', import.meta.url));
  const read = (p: string) => readFileSync(join(src, p), 'utf8');
  const code = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('the view takes no token prop and renders none of its inputs as text', () => {
    expect(code(read('components/invite/join-view.tsx'))).not.toMatch(/token/i);
  });
  it('the Join page never calls create-workspace itself and never routes to it', () => {
    const page = code(read('app/invite/page.tsx'));
    expect(page).not.toMatch(/new-workspace/);
    expect(page).not.toMatch(/api\.POST\('\/api\/v1\/workspaces'/);
    expect(page).not.toMatch(/console\./);
  });
  it('the only workspaces POST on the invite path carries joinWorkspaceBody (token, no name)', () => {
    const api = code(read('lib/invite-api.ts'));
    expect(api.match(/api\.POST\('\/api\/v1\/workspaces', \{ body: [^}]*\}/g)).toEqual(["api.POST('/api/v1/workspaces', { body: joinWorkspaceBody(token) }"]);
  });
  it('the create-workspace screen is gated: its default export checks the held invite before rendering the form', () => {
    const page = code(read('app/new-workspace/page.tsx'));
    const gate = page.slice(page.indexOf('export default function NewWorkspacePage'));
    expect(gate).toMatch(/newWorkspaceGate\(heldInviteToken\(window\.sessionStorage/);
    expect(gate).toMatch(/router\.replace\(gate\.redirectTo\)/);
    expect(gate.indexOf('newWorkspaceGate')).toBeLessThan(gate.indexOf('<NewWorkspaceForm'));
    expect(page).not.toMatch(/export default function NewWorkspaceForm/);
  });
  it('the entry route decides through postSignInDestination, so "no workspace yet" cannot bypass a held invite', () => {
    const home = code(read('app/page.tsx'));
    expect(home).toMatch(/postSignInDestination\(\{[^}]*held: heldInviteToken/);
    expect(home).not.toMatch(/'\/new-workspace'/);
  });
  it('sign-up and sign-in pages hand an invite to the Join screen instead of drawing their generic form', () => {
    for (const p of ['app/(auth)/signup/page.tsx', 'app/(auth)/login/page.tsx']) {
      const page = code(read(p));
      expect(page).toMatch(/inviteTokenFromNext\(rawNext\)/);
      expect(page).toMatch(/router\.replace\(inviteJoinPath\(inviteToken\)\)/);
    }
  });
  it('the reset request carries the invite into the email, and the new-password form returns to it', () => {
    expect(code(read('app/(auth)/reset/page.tsx'))).toMatch(/inviteResetRedirect\(window\.location\.origin, inviteToken\)/);
    expect(code(read('app/(auth)/reset/confirm/page.tsx'))).toMatch(/resetDoneDestination\(params\.get\('next'\)\)/);
  });
  it('the Join page sends sign-up, Google and verification back to itself', () => {
    const page = code(read('app/invite/page.tsx'));
    expect(page).toMatch(/inviteGoogleCallbacks\(window\.location\.origin, token\)/);
    expect(page).toMatch(/callbackURL: inviteVerificationCallback\(window\.location\.origin, token\)/);
    expect(page).toMatch(/land\(await joinWithToken\(token\)\)/);
  });
});
