import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ActionWhat } from './agent-actions';
import { isAiSource, type AuditEventRow } from '@/lib/governance';
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
