import { describe, expect, it, vi } from 'vitest';
import type { JoinClient } from './invite-api';
import { acceptInvite, joinWithToken, inviteDetailsUrl, fetchInviteDetails, joinFailureFrom, joinWorkspaceBody, parseInviteDetails } from './invite-api';

const TOKEN = 'pinewoodInviteTokenAbCdEf-_0123456';
const good = { status: 'valid', inviter_name: 'Maple Ridge', workspace_name: 'Pinewood Studio', workspace_logo_url: null, invited_email: 'a@pinewood.example' };

describe('parseInviteDetails (the contract of PR 1540)', () => {
  it('accepts exactly the five fields, every status', () => {
    for (const status of ['valid', 'expired', 'used', 'revoked', 'not_found']) expect(parseInviteDetails({ ...good, status })?.status).toBe(status);
  });
  it('rejects anything that is not the contract, so a proxy page never draws a screen', () => {
    for (const bad of [null, 'html', 3, {}, { ...good, status: 'banana' }, { ...good, inviter_name: 4 }, { status: 'valid' }]) expect(parseInviteDetails(bad)).toBeNull();
  });
  it('drops fields the contract does not name', () => {
    expect(Object.keys(parseInviteDetails({ ...good, role: 'admin', email: 'x' })!).sort()).toEqual(['invited_email', 'inviter_name', 'status', 'workspace_logo_url', 'workspace_name']);
  });
});

describe('the invite_revoked code (ticket #1304)', () => {
  it('maps to revoked, not to other', () => {
    expect(joinFailureFrom({ error: { code: 'invite_revoked' } })).toBe('revoked');
    expect(joinFailureFrom({ error: { code: 'something_else' } })).toBe('other');
  });
});

describe('fetchInviteDetails', () => {
  const respond = (init: { ok?: boolean; body?: unknown; throws?: boolean }) =>
    (async (_url: unknown, _opts: unknown) => {
      if (init.throws) throw new Error('offline');
      return { ok: init.ok ?? true, json: async () => init.body } as Response;
    }) as unknown as typeof fetch;

  it('reads the details', async () => {
    expect((await fetchInviteDetails(TOKEN, respond({ body: good })))?.workspace_name).toBe('Pinewood Studio');
  });
  it('a revoked body is read as revoked, so the screen never falls through to "could not check" (ticket #1304)', async () => {
    const d = await fetchInviteDetails(TOKEN, respond({ body: { ...good, status: 'revoked' } }));
    expect(d?.status).toBe('revoked');
    expect(d?.inviter_name).toBe('Maple Ridge');
  });
  it('is null (could not find out), never not_found, on a 429, a network failure or a non-contract body', async () => {
    expect(await fetchInviteDetails(TOKEN, respond({ ok: false, body: good }))).toBeNull();
    expect(await fetchInviteDetails(TOKEN, respond({ throws: true }))).toBeNull();
    expect(await fetchInviteDetails(TOKEN, respond({ body: '<html>' }))).toBeNull();
  });
  it('asks without credentials and without a cache, with the token encoded in the query', async () => {
    let seen: { url: string; opts: RequestInit } | null = null;
    await fetchInviteDetails('a b', (async (url: string, opts: RequestInit) => {
      seen = { url, opts };
      return { ok: true, json: async () => good } as Response;
    }) as unknown as typeof fetch);
    expect(seen!.opts).toMatchObject({ credentials: 'omit', cache: 'no-store' });
    expect(inviteDetailsUrl('a b', 'https://x.test')).toBe('https://x.test/api/v1/public/invites/details?token=a%20b');
  });
});

describe('joinFailureFrom: the stable codes', () => {
  it('maps the four codes of PR 1540 and nothing else', () => {
    const e = (code: string) => ({ error: { code, message: 'x' } });
    expect(joinFailureFrom(e('invite_not_found'))).toBe('not_found');
    expect(joinFailureFrom(e('invite_expired'))).toBe('expired');
    expect(joinFailureFrom(e('invite_email_mismatch'))).toBe('mismatch');
    expect(joinFailureFrom(e('already_a_member'))).toBe('already_member');
    expect(joinFailureFrom(e('error'))).toBe('other');
    expect(joinFailureFrom(null)).toBe('other');
    expect(joinFailureFrom({ error: { message: 'no code' } })).toBe('other');
  });
});

describe('joinWorkspaceBody', () => {
  it('is the token and nothing that could name a workspace to create', () => {
    expect(joinWorkspaceBody(TOKEN)).toEqual({ invite_token: TOKEN });
  });
});

import { joinFailureMessage, joinModel } from './invite-screen';

describe('a thrown request is a failed accept, not an uncaught error (#1302)', () => {
  const offline = (): JoinClient => ({ POST: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) });
  const ok = (key: string): JoinClient => ({ POST: vi.fn().mockResolvedValue({ data: { [key]: 'ws-1' } }) });
  const http = (code: string): JoinClient => ({ POST: vi.fn().mockResolvedValue({ error: { error: { code } } }) });

  it('acceptInvite and joinWithToken resolve to a failure with the retry sentence when fetch throws', async () => {
    for (const run of [() => acceptInvite(TOKEN, offline()), () => joinWithToken(TOKEN, offline())]) {
      const r = await run(); // must RESOLVE: a rejection here is the stuck "Joining…" button
      expect(r).toEqual({ ok: false, failure: 'other' });
      expect(joinFailureMessage((r as { failure: 'other' }).failure, null)).toBe('Could not join the workspace. Try again.');
    }
  });
  it('the failed attempt leaves the screen un-joined, so the Join button is drawn enabled; a retry then succeeds', async () => {
    const client = { POST: vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce({ data: { workspace_id: 'ws-1' } }) } as JoinClient;
    const first = await acceptInvite(TOKEN, client);
    expect(first.ok).toBe(false);
    const details = { status: 'valid' as const, inviter_name: 'Maple Ridge', workspace_name: 'Pinewood Studio', workspace_logo_url: null, invited_email: 'a@pinewood.example' };
    // not joined after a failure: the one-click screen, not the PR-1558 'joining' one
    expect(joinModel({ details, session: { status: 'signed_in', email: 'a@pinewood.example' }, joined: false }).kind).toBe('join_one_click');
    expect(await acceptInvite(TOKEN, client)).toEqual({ ok: true, workspaceId: 'ws-1' });
    expect(joinModel({ details: { ...details, status: 'used' }, session: { status: 'signed_in', email: 'a@pinewood.example' }, joined: true }).kind).toBe('joining');
  });
  it('HTTP errors keep their specific failures and success keeps its id', async () => {
    expect(await acceptInvite(TOKEN, http('invite_email_mismatch'))).toEqual({ ok: false, failure: 'mismatch' });
    expect(await acceptInvite(TOKEN, http('invite_expired'))).toEqual({ ok: false, failure: 'expired' });
    expect(await acceptInvite(TOKEN, http('invite_not_found'))).toEqual({ ok: false, failure: 'not_found' });
    expect(await joinWithToken(TOKEN, http('already_a_member'))).toEqual({ ok: false, failure: 'already_member' });
    expect(await acceptInvite(TOKEN, ok('workspace_id'))).toEqual({ ok: true, workspaceId: 'ws-1' });
    expect(await joinWithToken(TOKEN, ok('id'))).toEqual({ ok: true, workspaceId: 'ws-1' });
  });
  it('the token is sent in the body and never appears in the result of a failure', async () => {
    const r = await acceptInvite(TOKEN, offline());
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });
});
