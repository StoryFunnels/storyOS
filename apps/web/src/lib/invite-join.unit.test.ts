import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  INVITE_STASH_KEY,
  INVITE_STASH_TTL_MS,
  clearHeldInviteToken,
  heldInviteToken,
  inviteGoogleCallbacks,
  inviteJoinPath,
  inviteResetRedirect,
  inviteTokenFromNext,
  inviteVerificationCallback,
  isPlausibleInviteToken,
  loginHrefForInvite,
  newWorkspaceGate,
  postSignInDestination,
  resetDoneDestination,
  resetHrefForInvite,
  resolveInviteToken,
  scrubTokensFromEvent,
  scrubTokensInUrl,
  signupHrefForInvite,
  stashInviteToken,
} from './invite-join';
import { joinWorkspaceBody } from './invite-api';

// Pinewood-shaped, made up: 32 chars of base64url like the API's randomBytes(24).
const TOKEN = 'pinewoodInviteTokenAbCdEf-_0123456';
const ORIGIN = 'http://localhost:3210';

function memoryStore() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    has: (k: string) => data.has(k),
  };
}

/** The `next` a hop carries, read back off the URL the way the destination page reads it. */
const nextOf = (href: string) => new URL(href, ORIGIN).searchParams.get('next');

describe('the token shape and the Join path (#1302)', () => {
  it('accepts what the API issues and nothing that could smuggle a second parameter', () => {
    expect(isPlausibleInviteToken(TOKEN)).toBe(true);
    for (const bad of ['', 'short', null, undefined, 42, `${TOKEN}&x=1`, `${TOKEN}/../`, 'a'.repeat(257), `${TOKEN} `]) expect(isPlausibleInviteToken(bad)).toBe(false);
  });
  it('spells the Join screen in one place and reads it back', () => {
    expect(inviteJoinPath(TOKEN)).toBe(`/invite?token=${TOKEN}`);
    expect(inviteTokenFromNext(inviteJoinPath(TOKEN))).toBe(TOKEN);
  });
  it('reads a token only from the Join screen, same-site paths only', () => {
    for (const next of [null, '', '/', '/w/1', '/invite', '/invite?token=short', `//evil.com/invite?token=${TOKEN}`, `https://evil.com/invite?token=${TOKEN}`, `/other?token=${TOKEN}`]) {
      expect(inviteTokenFromNext(next)).toBeNull();
    }
  });
});

describe('every hop carries the token (#1302: survives sign-up, Google, verification, reset)', () => {
  it('sign-up, sign-in and reset pages reached from the invite carry the Join screen as next', () => {
    for (const href of [signupHrefForInvite(TOKEN), loginHrefForInvite(TOKEN), resetHrefForInvite(TOKEN)]) {
      expect(inviteTokenFromNext(nextOf(href))).toBe(TOKEN);
    }
    expect(signupHrefForInvite(TOKEN).startsWith('/signup?')).toBe(true);
    expect(loginHrefForInvite(TOKEN).startsWith('/login?')).toBe(true);
    expect(resetHrefForInvite(TOKEN).startsWith('/reset?')).toBe(true);
  });
  it('Google: all three callbacks come back to the Join screen on the web origin, with the funnel markers', () => {
    const c = inviteGoogleCallbacks(ORIGIN, TOKEN);
    for (const url of Object.values(c)) {
      const u = new URL(url);
      expect(u.origin).toBe(ORIGIN);
      expect(u.pathname).toBe('/invite');
      expect(u.searchParams.get('token')).toBe(TOKEN);
    }
    expect(new URL(c.callbackURL).searchParams.get('auth_event')).toBe('logged_in');
    expect(new URL(c.newUserCallbackURL).searchParams.get('auth_event')).toBe('signed_up');
    expect(new URL(c.newUserCallbackURL).searchParams.get('method')).toBe('google');
    // a failed Google attempt still lands on the Join screen, not on `/`
    expect(c.errorCallbackURL).toBe(`${ORIGIN}/invite?token=${TOKEN}`);
  });
  it('email verification: the link in the email lands on the Join screen (absolute: better-auth resolves a relative one against the API)', () => {
    const u = new URL(inviteVerificationCallback(ORIGIN, TOKEN));
    expect([u.origin, u.pathname, u.searchParams.get('token')]).toEqual([ORIGIN, '/invite', TOKEN]);
  });
  it('password reset: the email brings the person to the new-password form with the Join screen as next, and ends there', () => {
    const redirect = new URL(inviteResetRedirect(ORIGIN, TOKEN));
    expect(redirect.pathname).toBe('/reset/confirm');
    expect(inviteTokenFromNext(redirect.searchParams.get('next'))).toBe(TOKEN);
    // better-auth appends ?token=<reset token> with URLSearchParams: both survive side by side
    redirect.searchParams.set('token', 'RESETTOKEN');
    expect(inviteTokenFromNext(redirect.searchParams.get('next'))).toBe(TOKEN);
    expect(resetDoneDestination(redirect.searchParams.get('next'))).toBe(inviteJoinPath(TOKEN));
  });
  it('a reset that did not start from an invite still ends on the sign-in page', () => {
    expect(resetDoneDestination(null)).toBe('/login');
    expect(resetDoneDestination('/w/abc')).toBe('/login');
  });
});

describe('the short-lived held token (#1302 fallback)', () => {
  it('holds a token and reads it back', () => {
    const s = memoryStore();
    stashInviteToken(s, TOKEN, 1_000);
    expect(heldInviteToken(s, 1_000)).toBe(TOKEN);
  });
  it('forgets it after the TTL, and removes the stale entry', () => {
    const s = memoryStore();
    stashInviteToken(s, TOKEN, 0);
    expect(heldInviteToken(s, INVITE_STASH_TTL_MS - 1)).toBe(TOKEN);
    expect(heldInviteToken(s, INVITE_STASH_TTL_MS)).toBeNull();
    expect(s.has(INVITE_STASH_KEY)).toBe(false);
  });
  it('never holds something that is not a token, and reads a corrupt entry as none', () => {
    const s = memoryStore();
    stashInviteToken(s, 'nope', 0);
    expect(s.has(INVITE_STASH_KEY)).toBe(false);
    s.setItem(INVITE_STASH_KEY, '{not json');
    expect(heldInviteToken(s, 0)).toBeNull();
    s.setItem(INVITE_STASH_KEY, JSON.stringify({ t: TOKEN, at: 'later' }));
    expect(heldInviteToken(s, 0)).toBeNull();
  });
  it('clear removes it', () => {
    const s = memoryStore();
    stashInviteToken(s, TOKEN, 0);
    clearHeldInviteToken(s);
    expect(heldInviteToken(s, 0)).toBeNull();
  });
  it('survives a storage that throws', () => {
    const throwing = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } };
    expect(() => stashInviteToken(throwing, TOKEN, 0)).not.toThrow();
    expect(heldInviteToken(throwing, 0)).toBeNull();
    expect(() => clearHeldInviteToken(throwing)).not.toThrow();
  });
  it('resolves URL first, then next, then the held one', () => {
    const s = memoryStore();
    const other = 'otherInviteTokenXyZ-_9876543210';
    stashInviteToken(s, other, 0);
    expect(resolveInviteToken({ queryToken: TOKEN, next: null, store: s, now: 1 })).toBe(TOKEN);
    expect(resolveInviteToken({ queryToken: null, next: inviteJoinPath(TOKEN), store: s, now: 1 })).toBe(TOKEN);
    expect(resolveInviteToken({ queryToken: null, next: null, store: s, now: 1 })).toBe(other);
    expect(resolveInviteToken({ queryToken: 'junk', next: null, store: memoryStore(), now: 1 })).toBeNull();
  });
});

describe('there is never a create-workspace step on an invite path (#1302)', () => {
  it('the entry route sends a held invite to the Join screen, even with no workspace yet', () => {
    expect(postSignInDestination({ workspaceIds: [], held: TOKEN })).toBe(inviteJoinPath(TOKEN));
    expect(postSignInDestination({ workspaceIds: ['w1'], held: TOKEN })).toBe(inviteJoinPath(TOKEN));
  });
  it('and still behaves as before when nothing is held', () => {
    expect(postSignInDestination({ workspaceIds: [], held: null })).toBe('/new-workspace');
    expect(postSignInDestination({ workspaceIds: ['w1', 'w2'], held: null })).toBe('/w/w1');
  });
  it('the create-workspace screen refuses to render while an invite is held', () => {
    expect(newWorkspaceGate(TOKEN)).toEqual({ allow: false, redirectTo: inviteJoinPath(TOKEN) });
    expect(newWorkspaceGate(null)).toEqual({ allow: true });
  });
  it('the onboarding call on an invite path carries the token and cannot create a workspace', () => {
    expect(joinWorkspaceBody(TOKEN)).toEqual({ invite_token: TOKEN });
    expect(Object.keys(joinWorkspaceBody(TOKEN))).not.toContain('name');
  });

  /**
   * The flow test. Each path an invited person can take is walked hop by hop: the URL a hop produces is parsed by the next hop the
   * way the real page parses it. Whatever the path, the person ends on the Join screen holding the token and the one call made
   * there is the join. A hop that dropped the token, or that routed to /new-workspace, fails here.
   */
  const paths: Record<string, string[]> = {
    'password sign-up': [inviteJoinPath(TOKEN)],
    'existing account sign-in': [inviteJoinPath(TOKEN)],
    'sign-up form reached from the generic link': [signupHrefForInvite(TOKEN)],
    'sign-in page reached from the generic link': [loginHrefForInvite(TOKEN)],
    'Google, returning': [inviteGoogleCallbacks(ORIGIN, TOKEN).callbackURL],
    'Google, new account': [inviteGoogleCallbacks(ORIGIN, TOKEN).newUserCallbackURL],
    'Google, failed': [inviteGoogleCallbacks(ORIGIN, TOKEN).errorCallbackURL],
    'email verification link': [inviteVerificationCallback(ORIGIN, TOKEN)],
    'password reset link': [inviteResetRedirect(ORIGIN, TOKEN)],
  };
  for (const [name, hops] of Object.entries(paths)) {
    it(`${name}: ends on the Join screen with the token, never on create-workspace`, () => {
      for (const hop of hops) {
        const u = new URL(hop, ORIGIN);
        // The page a hop lands on reads the token from its own URL (/invite) or from `next` (/signup, /login, /reset/confirm).
        const token = u.pathname === '/invite' ? u.searchParams.get('token') : inviteTokenFromNext(u.searchParams.get('next'));
        expect(token).toBe(TOKEN);
        const dest = u.pathname === '/invite' ? hop : inviteJoinPath(token!);
        expect(dest).toContain(`token=${TOKEN}`);
        // Signing in from there and landing on `/`, with the token only held: still not the create step.
        const s = memoryStore();
        stashInviteToken(s, token!, 0);
        expect(postSignInDestination({ workspaceIds: [], held: heldInviteToken(s, 1) })).not.toBe('/new-workspace');
        expect(newWorkspaceGate(heldInviteToken(s, 1)).allow).toBe(false);
      }
    });
  }
});

describe('the token stays out of analytics (#1302)', () => {
  it('redacts a token query value and a token inside next', () => {
    expect(scrubTokensInUrl(`http://localhost:3210/invite?token=${TOKEN}`)).toBe('http://localhost:3210/invite?token=redacted');
    expect(scrubTokensInUrl(`/reset/confirm?next=${encodeURIComponent(inviteJoinPath(TOKEN))}&token=RESETSECRET`)).toBe(
      `/reset/confirm?next=${encodeURIComponent('/invite?token=redacted')}&token=redacted`,
    );
    expect(scrubTokensInUrl('/w/abc?tab=1')).toBe('/w/abc?tab=1');
  });
  it('redacts it in every URL-valued property of an event, and leaves the rest alone', () => {
    const out = scrubTokensFromEvent({
      event: '$pageview',
      properties: { $current_url: `https://app.example/invite?token=${TOKEN}`, $referrer: `https://app.example/invite?token=${TOKEN}`, $pathname: '/invite', count: 3 },
    } as { event: string; properties: Record<string, unknown> });
    expect(JSON.stringify(out)).not.toContain(TOKEN);
    expect(out.properties.$pathname).toBe('/invite');
    expect(out.properties.count).toBe(3);
    expect(scrubTokensFromEvent(null)).toBeNull();
  });
  it('is wired into PostHog before_send, and the page never sends the token as an event property', () => {
    const src = fileURLToPath(new URL('..', import.meta.url));
    expect(readFileSync(join(src, '../instrumentation-client.ts'), 'utf8')).toMatch(/withSurface\(scrubTokensFromEvent\(event\)\)/);
    const page = readFileSync(join(src, 'app/invite/page.tsx'), 'utf8');
    for (const m of page.matchAll(/posthog\.capture\([^)]*\)/g)) expect(m[0]).not.toMatch(/token/i);
    expect(page).not.toMatch(/console\./);
  });
});
