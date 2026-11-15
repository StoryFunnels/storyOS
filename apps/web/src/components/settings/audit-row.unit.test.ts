import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AuditActor, AuditLoadError, AuditWhat, auditFeedState, collapseDuplicateUpdates, type AuditLogEntry, type AuditRecordRef } from './audit-row';

// Ticket #1287: the row's visible text, from the API's resolved fields. Fake workspace data only.
const WS = 'ws-1';
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').replace(/ :/g, ':').trim();
const members: Record<string, string> = { u1abc: 'Ada Audit' };
const memberName = (id: string) => members[id];
const UUID = '4db75d42-699b-49c9-a34c-4f7631f6782a';

const rec = (over: Partial<AuditRecordRef> = {}): AuditRecordRef => ({
  id: UUID, number: 1060, title: 'Spring campaign', database_id: 'db-9', database_name: 'Campaigns', deleted: false, withheld: false, ...over,
});
const entry = (over: Partial<AuditLogEntry>): AuditLogEntry => ({
  kind: 'event', id: 'e1', record_id: UUID, type: 'record.updated', actor_id: null, actor_name: 'Ada Audit', source: 'human', created_at: '2026-11-14T10:00:00Z', ...over,
});
const render = (e: AuditLogEntry) => renderToStaticMarkup(createElement(AuditWhat, { entry: e, ws: WS, memberName }));

describe('AuditWhat: a record row names and links the record (#1287)', () => {
  it('record event: the sentence, the record number and title, and the database, linked to the record', () => {
    const html = render(entry({ record: rec() }));
    expect(text(html)).toBe('Record updated · #1060 Spring campaign in Campaigns');
    expect(html).toContain('href="/w/ws-1/d/db-9/r/spring-campaign-1060"');
  });

  it('created record: its title is named once, not twice', () => {
    const t = text(render(entry({ type: 'record.created', payload: { title: 'Spring campaign' }, record: rec() })));
    expect(t).toBe('Created · #1060 Spring campaign in Campaigns');
  });

  it('a withheld record is "a record": no name, no link, no id', () => {
    const html = render(entry({ record: rec({ withheld: true, number: null, title: null, database_id: null, database_name: null }) }));
    expect(text(html)).toBe('Record updated · a record');
    expect(html).not.toContain('href=');
    expect(html).not.toContain(UUID);
  });

  it('a purged record (no names at all) is a dash, not a guess', () => {
    const html = render(entry({ record: rec({ deleted: true, number: null, title: null, database_id: null, database_name: null }) }));
    expect(text(html)).toBe('Record updated · —');
  });

  it('a record in Trash keeps its name, says so, and is not linked', () => {
    const html = render(entry({ type: 'record.deleted', record: rec({ deleted: true }) }));
    expect(text(html)).toBe('Record moved to Trash · #1060 Spring campaign in Campaigns (in Trash)');
    expect(html).not.toContain('href=');
  });

  it('an untitled readable record says Untitled', () => {
    expect(text(render(entry({ record: rec({ title: '  ' }) })))).toContain('#1060 Untitled');
  });

  it('an older API (no record object) still renders the sentence and no id', () => {
    const html = render(entry({ record: undefined }));
    expect(text(html)).toBe('Record updated');
    expect(html).not.toContain(UUID);
  });
});

describe('AuditWhat: links name the other record (#1287)', () => {
  const linked = (other: AuditRecordRef | null) => entry({ type: 'relation.linked', payload: { other: { id: 'o1', title: 'Old title' } }, record: rec(), other_record: other });

  it('uses the other record\'s CURRENT title, linked, over the title written into the event', () => {
    const html = render(linked(rec({ id: 'o1', number: 7, title: 'Acme', database_name: 'Accounts', database_id: 'db-2' })));
    expect(text(html)).toBe('Linked to #7 Acme · #1060 Spring campaign in Campaigns');
    expect(html).toContain('href="/w/ws-1/d/db-2/r/acme-7"');
    expect(html).not.toContain('Old title');
  });

  it('withheld other record: falls back to what the event carries, which the API has already redacted', () => {
    const t = text(render(entry({ type: 'relation.linked', payload: { other: { id: 'o1' } }, record: rec(), other_record: rec({ id: 'o1', withheld: true, title: null, number: null, database_id: null, database_name: null }) })));
    expect(t).toBe('Records linked · #1060 Spring campaign in Campaigns');
  });

  it('no other_record (older API): the event\'s own title, as before', () => {
    const t = text(render(entry({ type: 'relation.linked', payload: { other: { id: 'o1', title: 'Old title' } }, record: undefined })));
    expect(t).toBe('Linked to “Old title”');
  });
});

describe('AuditWhat: field changes read as words (#1287)', () => {
  const change = (over: Partial<AuditLogEntry>) => entry({ kind: 'field_change', type: undefined, field: 'Phase', record: rec(), ...over });

  it('option labels from old_display/new_display, never the option ids', () => {
    const t = text(render(change({ old_value: UUID, new_value: '9d0a1c2e-1111-4222-8333-444455556666', old_display: 'Draft', new_display: 'Live' })));
    expect(t).toBe('Phase: Draft → Live · #1060 Spring campaign in Campaigns');
    expect(t).not.toMatch(/[0-9a-f]{8}-/);
  });

  it('an empty old value reads as a set, using the display value', () => {
    expect(text(render(change({ old_value: null, new_value: UUID, old_display: null, new_display: 'Live' })))).toContain('Set Phase to Live');
  });

  it('a person field uses the API\'s words ("A former member"), not the auth id', () => {
    const t = text(render(change({ field: 'Owner', old_value: 'ksTxCVvB5IaDBmlsWRKJDyXSABVGDi09', new_value: 'u1abc', old_display: 'A former member', new_display: 'Ada Audit' })));
    expect(t).toContain('Owner: A former member → Ada Audit');
    expect(t).not.toContain('ksTx');
  });

  it('an older API (no display): an unresolved id is still never printed', () => {
    const t = text(render(change({ old_value: UUID, new_value: 'u1abc' })));
    expect(t).toContain('Changed Phase');
    expect(t).not.toContain(UUID);
  });

  it('a change on a withheld record: field and values blanked by the API, so "Changed a field", not "a deleted field"', () => {
    const t = text(render(change({ field: null, old_value: null, new_value: null, old_display: null, new_display: null, record: rec({ withheld: true, title: null, number: null, database_id: null, database_name: null }) })));
    expect(t).toBe('Changed a field · a record');
  });
});

describe('guards stay wired (mutation anchors)', () => {
  const src = readFileSync(fileURLToPath(new URL('./audit-row.tsx', import.meta.url)), 'utf8');
  it('names the shared RelationChip and the record href builder, not its own link markup', () => {
    expect(src).toContain("from '@/components/table-view/relation-chip'");
    expect(src).toContain('recordHref(');
    expect(src).not.toMatch(/<a\s/);
  });
});

describe('a withheld record never prints a name from the event (#1287 item 1)', () => {
  const withheldRec = rec({ withheld: true, number: null, title: null, database_id: null, database_name: null });
  it('record.created with a title in the payload: "a record", the title is not drawn', () => {
    const html = render(entry({ type: 'record.created', payload: { title: 'Secret plan' }, record: withheldRec }));
    expect(text(html)).toBe('Created · a record');
    expect(html).not.toContain('Secret plan');
  });
  it('an outward event keeps its summary out of a withheld row', () => {
    const html = render(entry({ type: 'outward.watcher_email', payload: { summary: 'Mailed bob@example.com about Secret plan' }, record: withheldRec }));
    expect(html).not.toContain('Secret plan');
    expect(text(html)).toBe('Emailed a watcher about a change · a record');
  });
  it('a readable record still shows the name (the guard is not a blanket)', () => {
    expect(text(render(entry({ type: 'attachment.added', payload: { filename: 'plan.pdf' }, record: rec() })))).toContain('“plan.pdf”');
  });
});

describe('AuditActor: "(removed)" only when the API says so (#1287 item 3)', () => {
  const actor = (e: Partial<AuditLogEntry>) => text(renderToStaticMarkup(createElement(AuditActor, { entry: entry(e), memberName })));
  it('a tombstoned member keeps their name and gains the marker', () => {
    expect(actor({ actor_name: 'Ada Audit', actor_kind: 'member', actor_removed: true })).toBe('Ada Audit (removed)');
  });
  it('an active member has no marker', () => {
    expect(actor({ actor_name: 'Ada Audit', actor_kind: 'member', actor_removed: false })).toBe('Ada Audit');
  });
  it('an older API without the flag has no marker (never guessed)', () => {
    expect(actor({ actor_name: 'Ada Audit' })).toBe('Ada Audit');
  });
  it('"A former member" is not told twice', () => {
    expect(actor({ actor_name: 'A former member', actor_kind: 'member', actor_removed: true })).toBe('A former member');
  });
  it('a system actor never reads as removed', () => {
    expect(actor({ actor_name: 'Members sync', actor_kind: 'system', actor_removed: true })).toBe('Members sync');
  });
});

describe('a failed query is its own state, not "nothing matches" (#1287 item 2)', () => {
  it('error with nothing loaded: error state, even with filters applied', () => {
    expect(auditFeedState({ isLoading: false, isError: true, rows: 0, filtersApplied: 2 })).toBe('error');
    expect(auditFeedState({ isLoading: false, isError: true, rows: 0, filtersApplied: 0 })).toBe('error');
  });
  it('no error, nothing loaded: still the two empty states', () => {
    expect(auditFeedState({ isLoading: false, isError: false, rows: 0, filtersApplied: 2 })).toBe('empty-filtered');
    expect(auditFeedState({ isLoading: false, isError: false, rows: 0, filtersApplied: 0 })).toBe('empty');
  });
  it('an error after rows loaded keeps the rows on screen', () => {
    expect(auditFeedState({ isLoading: false, isError: true, rows: 3, filtersApplied: 0 })).toBe('rows');
  });
  it('the error card says it failed, has Try again, and claims no count or emptiness', () => {
    const t = text(renderToStaticMarkup(createElement(AuditLoadError, { onRetry: () => {} })));
    expect(t).toContain('Could not load the audit log');
    expect(t).toContain('Try again');
    expect(t).not.toContain('Nothing matches');
    expect(t).not.toMatch(/\d/);
  });
  it('the page renders the state from auditFeedState (wired, not just exported)', () => {
    const page = readFileSync(fileURLToPath(new URL('../../app/w/[ws]/settings/audit-log/page.tsx', import.meta.url)), 'utf8');
    expect(page).toContain('isError: log.isError');
    expect(page).toContain("feed === 'error'");
    expect(page).toContain('log.refetch()');
  });
});

describe('collapseDuplicateUpdates: a record.updated row that its field rows repeat is hidden (#1287 item 4)', () => {
  const T = '2026-11-14T10:00:00.000Z';
  const upd = (over: Partial<AuditLogEntry> = {}) => entry({ id: 'ev', type: 'record.updated', created_at: T, payload: { diff: { f1: {}, f2: {} } }, ...over });
  const fc = (id: string, over: Partial<AuditLogEntry> = {}) => entry({ kind: 'field_change', id, type: undefined, field: 'Status', created_at: T, ...over });
  const ids = (xs: AuditLogEntry[]) => xs.map((x) => x.id);

  it('hides the event when the field rows for the same record and instant equal its diff keys', () => {
    expect(ids(collapseDuplicateUpdates([upd(), fc('a'), fc('b')]))).toEqual(['a', 'b']);
  });
  it('keeps the event when it is the only evidence (no field rows: a Free workspace)', () => {
    expect(ids(collapseDuplicateUpdates([upd()]))).toEqual(['ev']);
  });
  it('keeps the event when fewer field rows are loaded than diff keys (a page split the write)', () => {
    expect(ids(collapseDuplicateUpdates([upd(), fc('a')]))).toEqual(['ev', 'a']);
  });
  it('keeps the event when the field rows belong to another record or another instant', () => {
    expect(ids(collapseDuplicateUpdates([upd(), fc('a', { record_id: 'other' }), fc('b', { created_at: '2026-11-14T10:00:01.000Z' })]))).toEqual(['ev', 'a', 'b']);
  });
  it('keeps the event when its payload has no diff', () => {
    expect(ids(collapseDuplicateUpdates([upd({ payload: {} }), fc('a'), fc('b')]))).toEqual(['ev', 'a', 'b']);
  });
  it('keeps a restore event: its sentence is information', () => {
    expect(ids(collapseDuplicateUpdates([upd({ payload: { diff: { f1: {} }, restored_from_version_id: 'v1' } }), fc('a')]))).toEqual(['ev', 'a']);
  });
  it('never touches other event types', () => {
    expect(ids(collapseDuplicateUpdates([upd({ id: 'c', type: 'comment.created' }), fc('a'), fc('b')]))).toEqual(['c', 'a', 'b']);
  });
});
