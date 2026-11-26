import { describe, expect, it } from 'vitest';
import { linkOptionLabel, linkRowHint, linkRows, linkSaveBody } from './github-link-databases';

/** Ticket #1368 — the per-repo link database rows. */
describe('linkRows', () => {
  it('while the old workspace-wide value is in force every repo shows it, marked as inherited', () => {
    expect(linkRows({ repos: ['pine/site', 'pine/pages'], link_database_id: 'db-1', link_databases: null })).toEqual([
      { repo: 'pine/site', databaseId: 'db-1', inherited: true },
      { repo: 'pine/pages', databaseId: 'db-1', inherited: true },
    ]);
  });

  it('with nothing configured a repo links nothing and is not marked inherited', () => {
    expect(linkRows({ repos: ['pine/site'], link_database_id: null, link_databases: null })).toEqual([
      { repo: 'pine/site', databaseId: null, inherited: false },
    ]);
  });

  it('once per repo, only the repo\'s own entry counts (stored lower-case, matched case-insensitively), never the old value', () => {
    expect(linkRows({ repos: ['Pine/Site', 'pine/pages'], link_database_id: 'db-old', link_databases: { 'pine/site': 'db-1' } })).toEqual([
      { repo: 'Pine/Site', databaseId: 'db-1', inherited: false },
      { repo: 'pine/pages', databaseId: null, inherited: false },
    ]);
  });
});

describe('linkSaveBody', () => {
  it('sets a repo\'s database, and the blank choice removes its entry with null', () => {
    expect(linkSaveBody('pine/site', 'db-1')).toEqual({ link_databases: { 'pine/site': 'db-1' } });
    expect(linkSaveBody('pine/site', '')).toEqual({ link_databases: { 'pine/site': null } });
  });
});

describe('labels', () => {
  it('names the identifier a database answers to, when it has a prefix', () => {
    expect(linkOptionLabel({ id: 'a', name: 'Issues', identifierPrefix: 'ISSUE' })).toBe('Issues (ISSUE-n)');
    expect(linkOptionLabel({ id: 'a', name: 'Notes', identifierPrefix: null })).toBe('Notes');
  });

  it('says what a row matches, what an unset one does not, and flags a deleted database', () => {
    const issues = { id: 'a', name: 'Issues', identifierPrefix: 'ISSUE' };
    expect(linkRowHint({ repo: 'r/x', databaseId: 'a', inherited: false }, issues)).toBe('Links into Issues. Matches ISSUE-n in the branch, title or description, and story-n or ticket #n.');
    expect(linkRowHint({ repo: 'r/x', databaseId: 'a', inherited: true }, { id: 'a', name: 'Notes' })).toBe(
      'Workspace-wide setting: Links into Notes. Matches story-n and ticket #n.',
    );
    expect(linkRowHint({ repo: 'r/x', databaseId: null, inherited: false }, undefined)).toContain('Links nothing');
    expect(linkRowHint({ repo: 'r/x', databaseId: 'gone', inherited: false }, undefined)).toContain('no longer exists');
  });
});
