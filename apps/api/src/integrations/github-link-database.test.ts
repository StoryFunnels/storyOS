import { describe, expect, it } from 'vitest';
import { linkDatabaseFor, withLinkDatabases } from './github-link-database';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

describe('linkDatabaseFor (ticket #1368: the link database belongs to a repo, not the workspace)', () => {
  it('legacy config (no per-repo map): the one workspace value applies to every repo, as before', () => {
    expect(linkDatabaseFor({ link_database_id: A }, 'acme/site')).toBe(A);
    expect(linkDatabaseFor({ link_database_id: A }, 'acme/other')).toBe(A);
    expect(linkDatabaseFor({}, 'acme/site')).toBeUndefined();
  });

  it('per-repo config: each repo answers with its own database, case-insensitively', () => {
    const cfg = { link_databases: { 'acme/site': A, 'acme/pages': B } };
    expect(linkDatabaseFor(cfg, 'acme/site')).toBe(A);
    expect(linkDatabaseFor(cfg, 'ACME/Pages')).toBe(B);
  });

  it("per-repo config: a repo with no entry links NOTHING (never the legacy value, never another repo's)", () => {
    expect(linkDatabaseFor({ link_database_id: A, link_databases: { 'acme/pages': B } }, 'acme/site')).toBeUndefined();
    expect(linkDatabaseFor({ link_databases: {} }, 'acme/site')).toBeUndefined();
  });
});

describe('withLinkDatabases (the first per-repo save migrates the old value)', () => {
  it('turns the legacy value into an explicit entry for every watched repo, then drops it', () => {
    const next = withLinkDatabases({ link_database_id: A, repos: ['acme/site', 'acme/api'] }, { 'acme/pages': B });
    expect(next.link_databases).toEqual({ 'acme/site': A, 'acme/api': A, 'acme/pages': B });
    expect(next.link_database_id).toBeUndefined();
  });

  it('an explicit entry wins over the migrated value; null removes an entry', () => {
    const next = withLinkDatabases({ link_database_id: A, repos: ['acme/site'] }, { 'acme/site': B });
    expect(next.link_databases).toEqual({ 'acme/site': B });
    const removed = withLinkDatabases({ link_databases: { 'acme/site': B, 'acme/api': A } }, { 'ACME/site': null });
    expect(removed.link_databases).toEqual({ 'acme/api': A });
  });

  it('with no watched repos and no legacy value it just records the entries', () => {
    expect(withLinkDatabases({}, { 'Acme/Site': A }).link_databases).toEqual({ 'acme/site': A });
  });
});
