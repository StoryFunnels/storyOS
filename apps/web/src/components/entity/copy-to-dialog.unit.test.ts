import { describe, expect, it } from 'vitest';
import { writableCopyTargets } from './copy-to-dialog';
import type { DatabaseSummary } from '@/lib/queries';

/**
 * #611 — the Copy-to picker must filter to write-accessible databases using
 * `my_access` directly, client-side, not the click-then-403 workaround it
 * shipped with (#433/#562). `'contributor'` is the same minimum
 * copy-record.service.ts's own assertAccess call requires.
 */
function makeDb(id: string, myAccess: DatabaseSummary['my_access']): DatabaseSummary {
  return {
    id,
    spaceId: 's1',
    folderId: null,
    name: id,
    icon: null,
    color: null,
    apiSlug: id,
    position: 0,
    my_access: myAccess,
  };
}

describe('writableCopyTargets', () => {
  it('excludes the source database itself, regardless of access', () => {
    const dbs = [makeDb('source', 'admin'), makeDb('other', 'admin')];
    const result = writableCopyTargets(dbs, 'source');
    expect(result.map((d) => d.id)).toEqual(['other']);
  });

  it('excludes a viewer-only database — the exact gap #562 filed', () => {
    const dbs = [makeDb('viewer-only', 'viewer'), makeDb('editor-db', 'editor')];
    const result = writableCopyTargets(dbs, 'unrelated');
    expect(result.map((d) => d.id)).toEqual(['editor-db']);
  });

  it('excludes a commenter-only database too — below the contributor floor', () => {
    const dbs = [makeDb('commenter-db', 'commenter')];
    expect(writableCopyTargets(dbs, 'unrelated')).toEqual([]);
  });

  it('includes contributor and everything above it, matching the API minimum exactly', () => {
    const dbs = [
      makeDb('contributor-db', 'contributor'),
      makeDb('editor-db', 'editor'),
      makeDb('creator-db', 'creator'),
      makeDb('admin-db', 'admin'),
    ];
    const result = writableCopyTargets(dbs, 'unrelated');
    expect(result.map((d) => d.id).sort()).toEqual(['admin-db', 'contributor-db', 'creator-db', 'editor-db']);
  });

  it('excludes a database with no my_access at all (null/undefined) — fails closed, not open', () => {
    const dbs = [makeDb('no-access-null', null), { ...makeDb('no-access-undefined', null), my_access: undefined }];
    expect(writableCopyTargets(dbs, 'unrelated')).toEqual([]);
  });
});
