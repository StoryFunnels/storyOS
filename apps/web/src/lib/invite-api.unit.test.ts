import { describe, expect, it } from 'vitest';
import { inviteDetailsUrl, fetchInviteDetails, joinFailureFrom, joinWorkspaceBody, parseInviteDetails } from './invite-api';

const TOKEN = 'pinewoodInviteTokenAbCdEf-_0123456';
const good = { status: 'valid', inviter_name: 'Maple Ridge', workspace_name: 'Pinewood Studio', workspace_logo_url: null, invited_email: 'a@pinewood.example' };

describe('parseInviteDetails (the contract of PR 1540)', () => {
  it('accepts exactly the five fields, every status', () => {
    for (const status of ['valid', 'expired', 'used', 'not_found']) expect(parseInviteDetails({ ...good, status })?.status).toBe(status);
  });
  it('rejects anything that is not the contract, so a proxy page never draws a screen', () => {
    for (const bad of [null, 'html', 3, {}, { ...good, status: 'revoked' }, { ...good, inviter_name: 4 }, { status: 'valid' }]) expect(parseInviteDetails(bad)).toBeNull();
  });
  it('drops fields the contract does not name', () => {
    expect(Object.keys(parseInviteDetails({ ...good, role: 'admin', email: 'x' })!).sort()).toEqual(['invited_email', 'inviter_name', 'status', 'workspace_logo_url', 'workspace_name']);
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
