import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PERSONAL_PRIVACY_SENTENCE } from './personal-space-copy';

const src = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('the Personal space privacy sentence (#1097, personal-space.md §1)', () => {
  it('is word for word what the ADR says: a drift is a support incident', () => {
    expect(PERSONAL_PRIVACY_SENTENCE).toBe('Only you can see this. If your account is removed, this content is deleted with it.');
    const adr = readFileSync(fileURLToPath(new URL('../../../../docs/architecture/personal-space.md', import.meta.url)), 'utf8');
    expect(adr.replace(/\s+/g, ' ')).toContain(PERSONAL_PRIVACY_SENTENCE);
  });

  it('appears at the three points of use, imported, never retyped', () => {
    const section = src('../components/personal-section.tsx');
    const page = src('../app/w/[ws]/personal/page.tsx');
    // the Personal page header
    expect(page).toMatch(/<header[\s\S]*\{PERSONAL_PRIVACY_SENTENCE\}[\s\S]*<\/header>/);
    // the create dialog for a personal view
    expect(section).toMatch(/<DialogContent title="New personal view" unsaved>[\s\S]*\{PERSONAL_PRIVACY_SENTENCE\}/);
    // the Personal row's tooltip
    expect(section).toMatch(/title=\{PERSONAL_PRIVACY_SENTENCE\}/);
    // nobody types the sentence out again
    for (const f of [section, page, src('../components/sidebar.tsx')]) expect(f).not.toContain('Only you can see this');
  });

  it('is NOT a standing paragraph in the sidebar any more, and the Personal row never draws a lock', () => {
    const section = src('../components/personal-section.tsx');
    expect(section).not.toMatch(/<p className="[^"]*"[^>]*>\s*<Lock/);
    expect(section).not.toMatch(/\bLock\b/);
    expect(section).not.toContain('uppercase tracking-wider text-faint">Personal');
    expect(section).toContain('UserRound');
  });
});

describe('personal items have one home and no lock (#1097)', () => {
  it('a personal view is dropped from the space tree, so it is never listed under its source database', () => {
    expect(src('../components/sidebar.tsx')).toMatch(/const spaceViews = \(viewsQuery\.data \?\? \[\]\)\.filter\(\(v\) => !v\.personal\);/);
  });
  it('a view row no longer draws a lock for personal: the lock means RESTRICTED (#924)', () => {
    const row = src('../components/sidebar-view-row.tsx');
    expect(row).not.toMatch(/\bLock\b/);
    expect(row).not.toContain('view.personal &&');
  });
  it('restricted spaces and databases keep their lock (#923/#924)', () => {
    const sidebar = src('../components/sidebar.tsx');
    expect(sidebar).toMatch(/showsLock\(space\)/);
    expect(sidebar).toMatch(/showsLock\(db\)/);
  });
});
