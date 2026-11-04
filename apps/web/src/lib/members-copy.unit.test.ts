import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CONVERTED_FROM_HOVER, MEMBERS_COPY, ROLE_DESCRIPTIONS } from './members-copy';

const SRC = fileURLToPath(new URL('..', import.meta.url));
const members = readFileSync(join(SRC, 'app/w/[ws]/settings/members/page.tsx'), 'utf8');

describe('no explanation on these pages is hover-only (#1186 AC3)', () => {
  it('lists the explanations converted from hover to visible text', () => {
    expect(CONVERTED_FROM_HOVER.map((c) => c.control)).toEqual(['Members › Export', 'Members › Erase', 'Members › Remove', 'Members › Copy link']);
  });

  it('each converted sentence is rendered by the Members page from the shared copy, as text', () => {
    expect(members).toContain('MEMBERS_COPY.exportDescription');
    expect(members).toContain('MEMBERS_COPY.eraseDescription');
    expect(members).toContain('MEMBERS_COPY.removeDescription');
    expect(members).toContain('MEMBERS_COPY.copyLinkDescription');
  });

  it('the four old tooltips are gone from the page: the sentence is not left ONLY in a title attribute', () => {
    for (const old of [
      'Export everything held about this member',
      'Remove: revoke their access to this workspace',
      'Erase from this workspace (GDPR): removes this person',
      'Copy the invite link to share directly',
    ]) {
      expect(members, old).not.toContain(old);
    }
    // A title attribute on a native element (a button) is the hover-only shape. The pages' `title=` props on Settings chrome are text.
    expect(members).not.toMatch(/<(Button|button|DialogTrigger)\b[^>]*\btitle=/);
  });

  it('the Export and Erase explanations say what the API does: Erase keeps authored content, it does not anonymise a name', () => {
    expect(MEMBERS_COPY.eraseDescription).toContain('this workspace only');
    expect(MEMBERS_COPY.eraseDescription).toContain('their comments and history stay');
    expect(MEMBERS_COPY.eraseDescription).not.toMatch(/anonymi[sz]es/i);
    expect(MEMBERS_COPY.eraseDescription).toContain('Can’t be undone');
  });

  it('every role says what it means in text in the menu', () => {
    expect(Object.keys(ROLE_DESCRIPTIONS)).toEqual(['admin', 'member', 'guest']);
    expect(members).toContain('ROLE_DESCRIPTIONS[r.value]');
  });

  it('no native select anywhere on the page: the member rows use the role menu, the invite dialog the shared MenuSelect (parity rows Members 4, 5, 12)', () => {
    expect(members).not.toMatch(/<select|<Select\b/);
    expect(members).toContain('<MenuSelect');
  });
});
