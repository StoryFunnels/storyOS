import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DELETE_ACCOUNT_BLOCKER, DELETE_ACCOUNT_CONSEQUENCES, ERASE_ME_BODY, emailConfirmMatches } from './erase-account';

describe('typing your email to delete your account (#1039)', () => {
  it('matches the email ignoring case and surrounding spaces', () => {
    expect(emailConfirmMatches('ievgen@example.com', 'ievgen@example.com')).toBe(true);
    expect(emailConfirmMatches('  Ievgen@Example.com ', 'ievgen@example.com')).toBe(true);
  });

  it.each(['', '   ', 'ievgen@example.co', 'ievgen', 'other@example.com', 'ievgen@example.com.evil'])('does not match %j', (typed) => {
    expect(emailConfirmMatches(typed, 'ievgen@example.com')).toBe(false);
  });

  it('an empty email never confirms anything', () => {
    expect(emailConfirmMatches('', '')).toBe(false);
  });
});

describe('what the confirmation says (#1039)', () => {
  it('lists the account, the memberships, the credentials and that it is irreversible', () => {
    const text = DELETE_ACCOUNT_CONSEQUENCES.join(' ');
    expect(text).toMatch(/account is erased/);
    expect(text).toMatch(/leave every workspace/);
    expect(text).toMatch(/sign-in, session, API token and AI connection/);
    expect(text).toMatch(/cannot be undone/);
  });

  it('names the last-admin block, which the server enforces with a 409', () => {
    expect(DELETE_ACCOUNT_BLOCKER).toMatch(/only admin of a workspace/);
    expect(DELETE_ACCOUNT_BLOCKER).toMatch(/promote another admin or delete that workspace/);
  });

  it('sends the literal confirm the API requires', () => {
    expect(ERASE_ME_BODY).toEqual({ confirm: true });
  });
});

describe('the two erasures never share words (#1039)', () => {
  const src = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8');
  it('the Members-page dialog says it is THIS workspace only and that the account is untouched; it no longer says it wipes an identity', () => {
    const members = src('app/w/[ws]/settings/members/page.tsx');
    expect(members).toMatch(/from this workspace only/i);
    expect(members).toMatch(/account.{0,40}(untouched|stays)/is);
    expect(members).not.toMatch(/wipes\s*\{?' '\}?\s*<span/);
    expect(members).not.toContain('anonymous tombstone');
    expect(members).not.toContain('Member erased and anonymized');
  });

  it('the account page offers Delete my account, through the one endpoint, and signs the person out afterwards', () => {
    const account = src('app/w/[ws]/settings/account/page.tsx');
    expect(account).toContain('Delete my account');
    expect(account).toContain('/api/v1/me/gdpr/erase');
    expect(account).toContain("window.location.assign('/login')");
  });
});
