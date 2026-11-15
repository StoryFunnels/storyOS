import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ActionWhat, FieldLines } from './agent-actions';
import { AdvancedSection } from '@/components/settings/settings-chrome';
import { enforcementSummary, fieldRowsOf, isAiSource, type AuditEventRow } from '@/lib/governance';
import type { AuditRecordRef } from '@/components/settings/audit-row';

// Ticket #1306: the Recent agent actions row says what happened in the audit log page's own words. Visible text only; fake data.
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim();
const UUID = '4db75d42-699b-49c9-a34c-4f7631f6782a';
const STORED = 'Onboarding Assistant ← Clients.Status = Onboarding';
const rec = (over: Partial<AuditRecordRef> = {}): AuditRecordRef => ({
  id: UUID, number: 1060, title: 'Spring campaign', database_id: 'db-9', database_name: 'Campaigns', deleted: false, withheld: false, ...over,
});
const row = (over: Partial<AuditEventRow> = {}): AuditEventRow => ({
  kind: 'event', id: 'e1', record_id: UUID, type: 'record.updated', actor_id: 'u1', actor_name: 'Ada', source: 'agent',
  credential_id: null, agent_name: 'Triage', payload: null, record: rec(), created_at: '2026-11-14T10:00:00Z', ...over,
});
const html = (r: AuditEventRow, words?: string | null) => renderToStaticMarkup(createElement(ActionWhat, { row: r, ws: 'ws-1', triggerWords: words }));

describe('ActionWhat: the same sentence as the audit log page (#1306)', () => {
  it('a record event reads as the audit log reads it, with the record number, title and database', () => {
    expect(text(html(row()))).toBe('Record updated · #1060 Spring campaign in Campaigns');
    expect(text(html(row({ type: 'comment.created' })))).toBe('Comment added · #1060 Spring campaign in Campaigns');
    expect(text(html(row({ type: 'record.deleted' })))).toBe('Record moved to Trash · #1060 Spring campaign in Campaigns');
  });
  it('the chip is not a link: the whole row is a button, and an anchor inside it would nest interactive elements', () => {
    expect(html(row())).not.toContain('href=');
  });
  it('no raw id, no dotted event code, whatever the row', () => {
    for (const r of [row(), row({ type: 'thing.was_frobbed' }), row({ record: null }), row({ record: rec({ withheld: true, title: null, number: null, database_id: null, database_name: null }) })]) {
      const t = text(html(r));
      expect(t).not.toContain(UUID);
      // an unknown code is the one place a code appears, and it is labelled "Event code:"
      expect(t.replace(/Event code: \S+/, '')).not.toMatch(/\b[a-z]+\.[a-z_]+\b/);
    }
  });
  it('a record the reader may not read is "a record"; an unresolved record is left out, not guessed', () => {
    expect(text(html(row({ record: rec({ withheld: true, title: null, number: null, database_id: null, database_name: null }) })))).toBe('Record updated · a record');
    expect(text(html(row({ record: null })))).toBe('Record updated');
  });
  it('an event code with no case is said as such, with the code marked as a code', () => {
    expect(text(html(row({ type: 'thing.was_frobbed', record: null })))).toBe('Something changed · Event code: thing.was_frobbed');
  });
  it('a wake rule is drawn from its fields, or "a wake rule", never the stored syntax (record title OR payload title)', () => {
    const words = "a wake rule for Onboarding Assistant: Clients' Status becomes Onboarding";
    const asRule = rec({ title: STORED, database_name: 'Agent Triggers' });
    expect(text(html(row({ type: 'record.created', payload: { title: STORED }, record: asRule }), words))).toBe(`Created ${words}`);
    expect(text(html(row({ type: 'record.created', payload: { title: STORED }, record: asRule })))).toBe('Created a wake rule');
    expect(text(html(row({ type: 'record.updated', record: asRule })))).toBe('Record updated · a wake rule');
    expect(text(html(row({ type: 'record.updated', record: null, payload: { title: STORED } })))).toBe('Record updated · a wake rule');
    for (const t of [html(row({ record: asRule }))]) expect(t).not.toContain('←');
  });
  it('a link whose far side is a wake rule falls back to the neutral sentence, never the stored syntax', () => {
    const far = rec({ id: 'far', title: STORED, number: 2, database_name: 'Agent Triggers' });
    const t = html(row({ type: 'relation.linked', other_record: far, payload: { other: { id: 'far', title: STORED } } }));
    expect(t).not.toContain('←');
    expect(text(t)).toContain('Records linked');
  });
  it('an ordinary title with an arrow in it is kept', () => {
    expect(text(html(row({ record: rec({ title: 'Plan ← Review notes' }) })))).toContain('Plan ← Review notes');
  });
  it('gold is decided by isAiSource, which the list still imports; the row mark is the Rocket', () => {
    expect(isAiSource('agent') && isAiSource('mcp') && !isAiSource('automation') && !isAiSource('human')).toBe(true);
  });
});

// Ticket #1284: the field-level lines under a "Record updated" row, from the field_change rows the same audit-log read already carries.
describe('FieldLines: "Set Phase: Review → Done" under the row (#1284)', () => {
  const at = '2026-11-14T10:00:00Z';
  const change = (id: string, field: string, from: string, to: string, over: Partial<AuditEventRow> = {}): AuditEventRow =>
    ({ ...row({ kind: 'field_change', id, type: undefined, created_at: at, record: rec() }), field, old_display: from, new_display: to, ...over }) as AuditEventRow;
  const ev = row({ id: 'ev', created_at: at });
  const lines = (entries: AuditEventRow[], e = ev) => renderToStaticMarkup(createElement(FieldLines, { lines: fieldRowsOf(e, entries), ws: 'ws-1' }));
  it('each changed field is drawn in the audit log\'s words, and the record is not repeated on the line', () => {
    const t = text(lines([ev, change('f1', 'Phase', 'Review', 'Done'), change('f2', 'Owner', '', 'Ada')]));
    expect(t).toContain('Phase : Review → Done');
    expect(t).not.toContain('Spring campaign');
    expect(t).not.toContain('href=');
  });
  it('only this write\'s rows: another record, another instant, a person\'s edit and a withheld record add nothing', () => {
    const other = [
      change('a', 'Phase', 'x', 'y', { record_id: 'other' }),
      change('b', 'Phase', 'x', 'y', { created_at: '2026-11-14T10:00:01Z' }),
      change('c', 'Phase', 'x', 'y', { source: 'human' }),
      change('d', 'Phase', 'x', 'y', { record: rec({ withheld: true, title: null, number: null, database_id: null, database_name: null }) }),
    ];
    expect(lines(other)).toBe('');
    expect(fieldRowsOf(row({ type: 'comment.created', created_at: at }), [change('e', 'Phase', 'x', 'y')])).toEqual([]);
  });
  it('past five lines the rest is counted, not dropped silently', () => {
    const six = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((n, i) => change(`g${i}`, n, '1', '2'));
    const t = text(lines(six));
    expect(t).toContain('A : 1 → 2');
    expect(t).not.toContain('F : 1 → 2');
    expect(t).toContain('and 2 more fields');
  });
});

// Ticket #1284: the "no gate" fact sits inside a closed disclosure, so its one-line summary must carry it in every state.
describe('governance-summary: the closed disclosure carries the gate fact in every state (#1284)', () => {
  const closed = (s: { loading: boolean; failed: boolean; ungoverned: boolean }) =>
    text(renderToStaticMarkup(createElement(AdvancedSection, { title: 'How agent rules are enforced', summary: enforcementSummary(s), children: createElement('p', null, 'INSIDE') })));
  it('no gate in force: says so, visibly, without opening', () => {
    expect(closed({ loading: false, failed: false, ungoverned: true })).toContain('How agent rules are enforced no approval gate is in force');
  });
  it('a gate in force: says what is inside, and does not claim the absence of a gate', () => {
    const t = closed({ loading: false, failed: false, ungoverned: false });
    expect(t).toContain('agents, gates, approvals and what always holds');
    expect(t).not.toContain('no approval gate');
  });
  it('load failed: says the gate status is unknown, and claims neither a gate nor its absence', () => {
    const t = closed({ loading: false, failed: true, ungoverned: true });
    expect(t).toContain('could not be loaded, so whether an approval gate is in force is unknown');
    expect(t).not.toContain('no approval gate is in force');
  });
  it('loading: names what is coming and says it is loading, no gate claim either way', () => {
    const t = closed({ loading: true, failed: false, ungoverned: true });
    expect(t).toContain('(loading)');
    expect(t).not.toContain('no approval gate');
  });
});
