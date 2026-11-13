import { describe, expect, it } from 'vitest';
import { NOT_FOUND_COPY, isUserAlreadyExists, joinFailureMessage, joinModel, sameEmail } from './invite-screen';
import type { InviteDetails } from './invite-api';

// Pinewood, made up.
const valid: InviteDetails = {
  status: 'valid',
  inviter_name: 'Maple Ridge',
  workspace_name: 'Pinewood Studio',
  workspace_logo_url: null,
  invited_email: 'new.hire@pinewood.example',
};
const out = { status: 'signed_out' } as const;
const asUser = (email: string) => ({ status: 'signed_in', email }) as const;

describe('joinModel: every state of the Join screen (#1302)', () => {
  it('valid, signed out: the invite, the locked email and ONE action named for the workspace', () => {
    expect(joinModel({ details: valid, session: out })).toEqual({
      kind: 'join_signed_out',
      title: 'Maple Ridge invited you to Pinewood Studio',
      workspaceName: 'Pinewood Studio',
      logoUrl: null,
      invitedEmail: 'new.hire@pinewood.example',
      action: 'Join Pinewood Studio',
    });
  });
  it('valid, signed in as the invited address (any casing): the one-click join', () => {
    expect(joinModel({ details: valid, session: asUser('New.Hire@Pinewood.example ') }).kind).toBe('join_one_click');
  });
  it('valid, signed in as someone else: the exact mismatch sentence and a Switch account action', () => {
    const m = joinModel({ details: valid, session: asUser('other@pinewood.example') });
    expect(m).toMatchObject({
      kind: 'mismatch',
      body: 'This invite was sent to new.hire@pinewood.example. You’re signed in as other@pinewood.example.',
      switchLabel: 'Switch account',
    });
  });
  it('expired and used say so and name the inviter, with no join', () => {
    const expired = joinModel({ details: { ...valid, status: 'expired' }, session: out });
    const used = joinModel({ details: { ...valid, status: 'used' }, session: asUser('x@y.example') });
    expect(expired).toMatchObject({ kind: 'expired', title: 'This invite has expired', body: 'Ask Maple Ridge for a new link.' });
    expect(used).toMatchObject({ kind: 'used', title: 'This invite was already used', body: 'Ask Maple Ridge for a new link.' });
  });
  it('an expired invite whose inviter has no name does not invent one', () => {
    expect(joinModel({ details: { ...valid, status: 'expired', inviter_name: null }, session: out })).toMatchObject({ body: 'Ask whoever invited you for a new link.' });
  });
  it('a title without an inviter name does not print "null"', () => {
    const m = joinModel({ details: { ...valid, inviter_name: null }, session: out });
    expect(m).toMatchObject({ title: 'You have been invited to Pinewood Studio' });
    expect((m as { title: string }).title).not.toMatch(/null|undefined/);
  });
  it('not_found is generic and names nobody (unknown, malformed, revoked and replaced are one answer)', () => {
    const body: InviteDetails = { status: 'not_found', inviter_name: null, workspace_name: null, workspace_logo_url: null, invited_email: null };
    expect(joinModel({ details: body, session: out })).toEqual({ kind: 'not_found', ...NOT_FOUND_COPY });
    expect(`${NOT_FOUND_COPY.title}. ${NOT_FOUND_COPY.body}`).toBe('This invite link no longer works. Ask whoever invited you for a new link.');
  });
  it('a not_found that still arrives with details (it should not) never leaks them', () => {
    const m = joinModel({ details: { ...valid, status: 'not_found' }, session: out });
    expect(JSON.stringify(m)).not.toContain('Maple Ridge');
    expect(JSON.stringify(m)).not.toContain('Pinewood');
  });
  it('waits while the details or the session are unknown, and says so when the details cannot be read', () => {
    expect(joinModel({ details: undefined, session: out }).kind).toBe('loading');
    expect(joinModel({ details: valid, session: { status: 'loading' } }).kind).toBe('loading');
    expect(joinModel({ details: null, detailsFailed: true, session: out }).kind).toBe('unavailable');
  });
  it('an unreachable API is not reported as a dead link', () => {
    expect(joinModel({ details: null, detailsFailed: true, session: out })).not.toMatchObject({ kind: 'not_found' });
  });
});

describe('sameEmail', () => {
  it('ignores case and surrounding space only', () => {
    expect(sameEmail(' A@B.example', 'a@b.example')).toBe(true);
    expect(sameEmail('a@b.example', 'a+x@b.example')).toBe(false);
    expect(sameEmail('a@b.example', '')).toBe(false);
  });
});

describe('isUserAlreadyExists', () => {
  it('reads better-auth’s code and its 422', () => {
    expect(isUserAlreadyExists({ code: 'USER_ALREADY_EXISTS' })).toBe(true);
    expect(isUserAlreadyExists({ code: 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL' })).toBe(true);
    expect(isUserAlreadyExists({ status: 422, message: 'User already exists' })).toBe(true);
  });
  it('is false for every other sign-up failure', () => {
    expect(isUserAlreadyExists(null)).toBe(false);
    expect(isUserAlreadyExists({ code: 'PASSWORD_TOO_SHORT', status: 400 })).toBe(false);
    expect(isUserAlreadyExists({ status: 422, message: 'Password too short' })).toBe(false);
  });
});

describe('joinFailureMessage', () => {
  it('a dead invite says so; the not-found one never names the inviter', () => {
    expect(joinFailureMessage('expired', 'Maple Ridge')).toBe('This invite has expired. Ask Maple Ridge for a new link.');
    expect(joinFailureMessage('not_found', 'Maple Ridge')).toBe('This invite link no longer works. Ask whoever invited you for a new link.');
  });
  it('the rest are plain', () => {
    expect(joinFailureMessage('mismatch', null)).toMatch(/different address/);
    expect(joinFailureMessage('already_member', null)).toMatch(/already a member/);
    expect(joinFailureMessage('other', null)).toMatch(/Try again/);
  });
});
