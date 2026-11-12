import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { WakesWhenValue, WorksInValue } from './agent-wake-facts';
import { canReadWakeFacts, wakeLines } from '@/lib/runners/wake-facts';
import type { DbLookup } from '@/lib/runners/wake-facts';

/** Ticket #1289 — the two rows of the agent page's facts box, drawn from fixtures that are local test data only. */
const AGENT = 'agent-1';
const clients: DbLookup = {
  kind: 'ok',
  db: { name: 'Clients', fields: [{ id: 'f-status', displayName: 'Status', options: [{ id: 'o-onb', label: 'Onboarding' }] }, { id: 'f-owner', displayName: 'Owner' }] },
};
const bind = (v: Record<string, unknown>) => ({ values: { agent: [{ id: AGENT }], database: 'db-clients', enabled: true, human_gate: false, ...v } });
const lookup = (id: string) => (id === 'db-clients' ? clients : undefined);
const draw = (el: unknown) => renderToStaticMarkup(el as never);

describe('Wakes when', () => {
  it('populated: says the state change in words, with the database linked', () => {
    const lines = wakeLines([bind({ state_field: 'f-status', state_option: 'o-onb' })], AGENT, lookup);
    const html = draw(createElement(WakesWhenValue, { state: { status: 'ready', value: lines }, ws: 'w1', linkDatabaseId: 'db-clients' }));
    expect(html).toContain('A client’s Status becomes Onboarding');
    expect(html).toContain('href="/w/w1/d/db-clients"');
    expect(html).not.toContain('db-clients</');
    expect(html).not.toContain('>Off<');
  });
  it('a switched-off trigger is shown, marked Off, never left out', () => {
    const lines = wakeLines([bind({ state_field: 'f-status', state_option: 'o-onb', enabled: false })], AGENT, lookup);
    expect(lines).toHaveLength(1);
    const html = draw(createElement(WakesWhenValue, { state: { status: 'ready', value: lines }, ws: 'w1', linkDatabaseId: 'db-clients' }));
    expect(html).toContain('data-state="off"');
    expect(html).toContain('>Off<');
  });
  it('a human-gated trigger says it starts only when a person does', () => {
    const html = draw(createElement(WakesWhenValue, { state: { status: 'ready', value: wakeLines([bind({ state_field: 'f-status', state_option: 'o-onb', human_gate: true })], AGENT, lookup) }, ws: 'w1', linkDatabaseId: null }));
    expect(html).toContain('Starts only when you do');
  });
  it('an assignment trigger reads as one', () => {
    expect(wakeLines([bind({ relation_field: 'f-owner' })], AGENT, lookup)[0]!.text).toBe('A client is assigned to it');
  });
  it('the article follows the noun: An issue, A client', () => {
    const issues: DbLookup = { kind: 'ok', db: { name: 'Issues', fields: [{ id: 'f-state', displayName: 'State', options: [{ id: 'o-tri', label: 'Triage' }] }] } };
    expect(wakeLines([bind({ database: 'db-issues', state_field: 'f-state', state_option: 'o-tri' })], AGENT, () => issues)[0]!.text).toBe('An issue’s State becomes Triage');
  });
  it('only this agent’s triggers are listed', () => {
    expect(wakeLines([bind({ agent: [{ id: 'someone-else' }], state_field: 'f-status', state_option: 'o-onb' })], AGENT, lookup)).toEqual([]);
  });
  it('empty: says no trigger of its own, and still says wake rules live in Automations (it never claims nothing else wakes it)', () => {
    const html = draw(createElement(WakesWhenValue, { state: { status: 'ready', value: [] }, ws: 'w1', linkDatabaseId: null }));
    expect(html).toContain('No trigger of its own.');
    expect(html).toContain('Wake rules are set per database, in Automations.');
    expect(html).not.toMatch(/nothing configured|never wakes|only when you start it/i);
  });
  it('dangling option, field and database read as deleted, never an id', () => {
    const [option, db] = wakeLines([bind({ state_field: 'f-status', state_option: 'o-gone' }), bind({ database: 'db-gone', state_field: 'x', state_option: 'y' })], AGENT, (id) => (id === 'db-gone' ? { kind: 'deleted' } : clients));
    expect(option!.text).toBe('A client’s trigger state (field or option deleted)');
    expect(db!.text).toBe('A trigger on a database that was deleted');
    expect(db!.databaseId).toBeNull();
    for (const t of [option!.text, db!.text]) expect(t).not.toMatch(/[0-9a-f]{8}-|f-status|o-gone|db-gone/);
  });
  it('loading and failed say so instead of a verdict', () => {
    expect(draw(createElement(WakesWhenValue, { state: { status: 'loading' }, ws: 'w1', linkDatabaseId: null }))).toContain('Loading…');
    expect(draw(createElement(WakesWhenValue, { state: { status: 'failed' }, ws: 'w1', linkDatabaseId: null }))).toContain('Could not read this just now.');
  });
});

describe('Works in', () => {
  const dbs = [{ id: 'd1', name: 'Clients', space_id: 's1', via: 'space' as const }, { id: 'd2', name: 'Contacts', space_id: 's1', via: 'space' as const }, { id: 'd3', name: 'Projects', space_id: 's2', via: 'database' as const }];
  it('populated: a whole space with its resolved databases now, a named database linked', () => {
    const html = draw(createElement(WorksInValue, { state: { status: 'ready', value: { enforced: true, spaces: [{ id: 's1', name: 'Client Work' }], databases: dbs, unresolved: [], withheld_count: 0 } }, ws: 'w1' }));
    expect(html).toContain('<b>Client Work</b> · whole space');
    expect(html).toContain('2 databases now: Clients, Contacts. Databases added to Client Work later are included.');
    expect(html).toContain('href="/w/w1/d/d3"');
    expect(html).not.toContain('Clients</a>');
  });
  it('databases only: names, no whole-space note', () => {
    const html = draw(createElement(WorksInValue, { state: { status: 'ready', value: { databases: [dbs[2]!], spaces: [], unresolved: [], withheld_count: 0 } }, ws: 'w1' }));
    expect(html).toContain('Projects');
    expect(html).not.toContain('whole space');
  });
  it('dangling targets are counted, never named; hidden ones are said', () => {
    const html = draw(createElement(WorksInValue, { state: { status: 'ready', value: { spaces: [], databases: [dbs[2]!], unresolved: ['3f2a1b9c-0000-4000-8000-000000000000', 'Old name'], withheld_count: 1 } }, ws: 'w1' }));
    expect(html).toContain('2 targets no longer exist or are private.');
    expect(html).toContain('1 more is not open to its manager');
    expect(html).not.toContain('3f2a1b9c');
    expect(html).not.toContain('Old name');
  });
  it('empty says no database chosen', () => {
    expect(draw(createElement(WorksInValue, { state: { status: 'ready', value: { spaces: [], databases: [], unresolved: [], withheld_count: 0 } }, ws: 'w1' }))).toContain('No database chosen.');
  });
});

describe('who sees the rows (member: 403 hidden)', () => {
  it('only an admin may read them: the agents controller is admin-only', () => {
    expect(canReadWakeFacts('admin')).toBe(true);
    for (const r of ['member', 'guest', undefined]) expect(canReadWakeFacts(r)).toBe(false);
  });
  it('the page asks nothing and draws nothing for anyone else', () => {
    const src = readFileSync(new URL('./agent-page.tsx', import.meta.url), 'utf8');
    expect(src).toContain('const readsFacts = canReadWakeFacts(role);');
    expect(src).toContain('useAgentWakeLines(ws, agentId, readsFacts)');
    expect(src).toContain('useAgentScope(ws, agentId, readsFacts)');
    expect(src).toContain('wakes={readsFacts ?');
    expect(src).toContain('works={readsFacts ?');
  });
  it('the hire card no longer promises to edit it all on the page', () => {
    const src = readFileSync(new URL('./hire-dialog.tsx', import.meta.url), 'utf8');
    expect(src).not.toContain('You can change all of this later on its page');
  });
});
