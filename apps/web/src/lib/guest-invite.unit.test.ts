import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FREE_GUEST_GRANTS, guestInviteHref, isBillableGuestGrant } from './guest-invite';

describe('guestInviteHref (#327)', () => {
  it('defaults to the free viewer tier when the caller says nothing', () => {
    expect(guestInviteHref({ ws: 'w1', spaceId: 's1' })).toBe(
      '/w/w1/settings/members?invite=guest&space=s1&grant=viewer',
    );
  });

  it('omits space and grant entirely for an unscoped invite', () => {
    expect(guestInviteHref({ ws: 'w1' })).toBe('/w/w1/settings/members?invite=guest');
    // A grant with nothing to apply it to would be misleading in the URL.
    expect(guestInviteHref({ ws: 'w1', grant: 'editor' })).toBe('/w/w1/settings/members?invite=guest');
  });

  it('treats a null spaceId the same as an absent one', () => {
    expect(guestInviteHref({ ws: 'w1', spaceId: null })).toBe('/w/w1/settings/members?invite=guest');
  });

  it('still allows a billable grant when the caller asks for it explicitly', () => {
    expect(guestInviteHref({ ws: 'w1', spaceId: 's1', grant: 'editor' })).toContain('grant=editor');
  });
});

describe('isBillableGuestGrant mirrors the server billing rule (#327)', () => {
  it('viewer and commenter are free', () => {
    for (const grant of FREE_GUEST_GRANTS) expect(isBillableGuestGrant(grant)).toBe(false);
  });

  it('contributor and above cost a seat', () => {
    // access.service.ts: billable once ACCESS_RANK[grant] >= ACCESS_RANK.contributor.
    for (const grant of ['contributor', 'editor', 'creator'] as const) {
      expect(isBillableGuestGrant(grant)).toBe(true);
    }
  });
});

/**
 * The regression guard that matters. #327 happened because three surfaces each
 * built this URL by hand and only one got fixed — a unit test of the helper
 * alone would have stayed green through the whole bug. This asserts nobody
 * hand-builds the link any more, so the surfaces cannot drift apart again.
 */
describe('no surface hand-builds a guest-invite URL (#327)', () => {
  const SRC = join(__dirname, '..');
  const CALLERS = [
    'app/new-workspace/page.tsx',
    'components/template-gallery.tsx',
    'components/share-dialog.tsx',
  ];

  /**
   * Comments are stripped before asserting. The fix commit explains itself in
   * prose — "this used to hard-code `grant=editor`" — and a naive substring
   * check would fail on the very comment that documents the fix.
   */
  const code = (file: string) =>
    readFileSync(join(SRC, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');

  it.each(CALLERS)('%s routes through guestInviteHref', (file) => {
    expect(code(file)).toContain('guestInviteHref');
    expect(code(file)).not.toMatch(/invite=guest/);
  });

  it('no caller hard-codes a billable grant', () => {
    for (const file of CALLERS) {
      expect(code(file)).not.toContain('grant=editor');
      expect(code(file)).not.toContain('grant=contributor');
    }
  });
});
