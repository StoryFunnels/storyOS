import { describe, expect, it } from 'vitest';
import { CsvSourceAdapter } from '../src/import/csv-source-adapter';
import { LinearSourceAdapter } from '../src/integrations/linear-source-adapter';

// Both adapters implement the framework's SourceAdapter contract (#198 /
// MN-236, ADR-0013): connect, readSchema, readRecords, and (optionally)
// readRelations. Pure-logic tests — no DB, no live Linear API.

describe('CsvSourceAdapter (MN-052) implements SourceAdapter', () => {
  const csv = ['Name,Budget,Urgent', 'Website refresh,12000,yes', 'Brand audit,4500,no'].join('\n');

  it('infers a schema from the header row + sample values', () => {
    const adapter = new CsvSourceAdapter();
    adapter.connect({ buffer: Buffer.from(csv) });
    const schema = adapter.readSchema();
    expect(schema).toEqual([
      { key: 'Name', label: 'Name', sourceType: 'text', options: undefined },
      { key: 'Budget', label: 'Budget', sourceType: 'number', options: undefined },
      { key: 'Urgent', label: 'Urgent', sourceType: 'checkbox', options: undefined },
    ]);
  });

  it('reads every row as a SourceRecord keyed by column, titled from the first column', async () => {
    const adapter = new CsvSourceAdapter();
    adapter.connect({ buffer: Buffer.from(csv) });
    const records = await adapter.readRecords();
    expect(records).toHaveLength(2);
    expect(records[0]).toEqual({
      sourceId: '0',
      title: 'Website refresh',
      fields: { Name: 'Website refresh', Budget: '12000', Urgent: 'yes' },
    });
  });

  it('sniffs the delimiter and strips a BOM', () => {
    const adapter = new CsvSourceAdapter();
    adapter.connect({ buffer: Buffer.from('﻿Name;Budget\nWebsite refresh;12000') });
    expect(adapter.parsedHeaders).toEqual(['Name', 'Budget']);
    expect(adapter.parsedRows).toEqual([['Website refresh', '12000']]);
  });
});

describe('LinearSourceAdapter (MN-066) implements SourceAdapter', () => {
  const TEAM_DATA = {
    labels: { nodes: [{ id: 'lbl-bug', name: 'bug', color: '#EB5757' }] },
    cycles: { nodes: [{ id: 'cyc-1', name: null, number: 12, startsAt: '2026-07-01', endsAt: '2026-07-14' }] },
    projects: { nodes: [{ id: 'proj-1', name: 'Sharing flow', description: 'desc', state: 'started', targetDate: '2026-08-01', url: 'https://linear.app/x' }] },
    issues: {
      nodes: [
        {
          id: 'iss-1', identifier: 'ENG-1', title: 'Share dialog loses focus', description: null,
          url: 'https://linear.app/acme/issue/ENG-1', estimate: 3, priority: 2,
          state: { type: 'started', name: 'In Progress' },
          labels: { nodes: [{ id: 'lbl-bug', name: 'bug', color: '#EB5757' }] },
          assignee: { name: 'Dana K' }, parent: null, cycle: { id: 'cyc-1' }, project: { id: 'proj-1' },
        },
        {
          id: 'iss-2', identifier: 'ENG-2', title: 'Fix focus trap', description: null,
          url: 'https://linear.app/acme/issue/ENG-2', estimate: null, priority: 0,
          state: { type: 'triage', name: 'Triage' }, labels: { nodes: [] },
          assignee: null, parent: { id: 'iss-1' }, cycle: null, project: null,
        },
      ],
    },
  };

  function fakeFetcher(query: string) {
    if (query.includes('teams {')) {
      return Promise.resolve({ teams: { nodes: [{ id: 'team-eng', key: 'ENG', name: 'Engineering' }] } });
    }
    return Promise.resolve({ team: TEAM_DATA });
  }

  it('connects, filters teams by key, and rejects when nothing matches', async () => {
    const adapter = new LinearSourceAdapter();
    await adapter.connect({ apiKey: 'k', teamKeys: ['ENG'], fetcher: fakeFetcher });
    // no throw = success; a non-matching key should reject
    const other = new LinearSourceAdapter();
    await expect(other.connect({ apiKey: 'k', teamKeys: ['NOPE'], fetcher: fakeFetcher })).rejects.toThrow(
      'No Linear teams matched',
    );
  });

  it('reads a static Issues schema', async () => {
    const adapter = new LinearSourceAdapter();
    await adapter.connect({ apiKey: 'k', teamKeys: [], fetcher: fakeFetcher });
    expect(adapter.readSchema().map((f) => f.key)).toEqual(['state', 'priority', 'identifier', 'assignee_name', 'estimate', 'url']);
  });

  it('flattens labels/sprints/projects/issues into tagged SourceRecords', async () => {
    const adapter = new LinearSourceAdapter();
    await adapter.connect({ apiKey: 'k', teamKeys: [], fetcher: fakeFetcher });
    const records = await adapter.readRecords();
    const containers = records.map((r) => r.container);
    expect(containers).toEqual(['label', 'sprint', 'project', 'issue', 'issue']);
    const issue = records.find((r) => r.sourceId === 'iss-1')!;
    expect(issue.title).toBe('Share dialog loses focus');
    expect(issue.fields.assignee_name).toBe('Dana K');
  });

  it('exposes parent/cycle/project/label edges as relation links, resolved separately from records', async () => {
    const adapter = new LinearSourceAdapter();
    await adapter.connect({ apiKey: 'k', teamKeys: [], fetcher: fakeFetcher });
    const links = await adapter.readRelations();
    expect(links).toContainEqual({ fromSourceId: 'iss-1', fieldKey: 'sprint', toSourceIds: ['cyc-1'] });
    expect(links).toContainEqual({ fromSourceId: 'iss-1', fieldKey: 'project', toSourceIds: ['proj-1'] });
    expect(links).toContainEqual({ fromSourceId: 'iss-1', fieldKey: 'labels', toSourceIds: ['lbl-bug'] });
    expect(links).toContainEqual({ fromSourceId: 'iss-2', fieldKey: 'parent_issue', toSourceIds: ['iss-1'] });
  });
});
