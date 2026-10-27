import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { adminRows, canReadGrants, everyoneRows, spaceAccessMode } from './space-access-section';

const m = (name: string, role: string) => ({ role, user: { name } });
const members = [m('Ada', 'admin'), m('Otto', 'member'), m('Mira', 'member'), m('Lena', 'guest')];

describe('spaceAccessMode (#1099)', () => {
  it('an unrestricted space keeps the original rendering for admins and members', () => {
    expect(spaceAccessMode({ restricted: false, workspaceRole: 'admin' })).toBe('everyone');
    expect(spaceAccessMode({ restricted: undefined, workspaceRole: 'member' })).toBe('everyone');
  });
  it('a restricted space lists names to admins only', () => {
    expect(spaceAccessMode({ restricted: true, workspaceRole: 'admin' })).toBe('restricted-admin');
    expect(spaceAccessMode({ restricted: true, workspaceRole: 'member' })).toBe('restricted-private');
  });
  it('a guest gets the existing explanation whatever the flag', () => {
    expect(spaceAccessMode({ restricted: true, workspaceRole: 'guest' })).toBe('guest');
    expect(spaceAccessMode({ restricted: false, workspaceRole: 'guest' })).toBe('guest');
  });
  it('only admins call /grants', () => {
    expect(canReadGrants('admin')).toBe(true);
    expect(canReadGrants('member')).toBe(false);
    expect(canReadGrants('guest')).toBe(false);
    expect(canReadGrants(undefined)).toBe(false);
  });
});

describe('rows (#1099)', () => {
  it('unrestricted: every admin and member, no guest', () => {
    expect(everyoneRows(members).map((r) => r.name)).toEqual(['Ada', 'Otto', 'Mira']);
  });
  it('restricted: admins only, so no ordinary member is named', () => {
    expect(adminRows(members).map((r) => r.name)).toEqual(['Ada']);
  });
});

describe('the page is wired through the model, not around it (#1099)', () => {
  const src = readFileSync(new URL('../app/w/[ws]/s/[space]/page.tsx', import.meta.url), 'utf8');
  it('uses the mode and no longer draws the member list unconditionally', () => {
    expect(src).toContain('spaceAccessMode(');
    expect(src).toContain('everyoneRows(');
    expect(src).not.toContain('workspaceMembers');
  });
  it('only fetches grants for an admin', () => {
    expect(src).toContain('enabled: canReadGrants(');
  });
});
