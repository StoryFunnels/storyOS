import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { auditActorLabel, hasRunDetails, showAiCostColumn, splitEmptyRuns, type RunDetails } from './admin-page';

const empty: RunDetails = { agent: null, status: null, runClass: null, trigger: null, startedAt: null, finishedAt: null };

describe('#1391 empty run rows', () => {
  it('a run with nothing recorded is empty', () => {
    expect(hasRunDetails(empty)).toBe(false);
  });

  it('a run that knows ANY single detail is kept: each detail on its own', () => {
    expect(hasRunDetails({ ...empty, agent: { id: 'a', title: 'Writer' } })).toBe(true);
    expect(hasRunDetails({ ...empty, status: 'Failed' })).toBe(true);
    expect(hasRunDetails({ ...empty, runClass: 'Scheduled' })).toBe(true);
    expect(hasRunDetails({ ...empty, trigger: 'Manual' })).toBe(true);
    expect(hasRunDetails({ ...empty, startedAt: '2026-11-27T10:00:00.000Z' })).toBe(true);
    expect(hasRunDetails({ ...empty, finishedAt: '2026-11-27T10:00:00.000Z' })).toBe(true);
  });

  it('splits the list, keeps order, and counts what it left out', () => {
    const runs = [
      { id: '1', ...empty, status: 'Succeeded' },
      { id: '2', ...empty },
      { id: '3', ...empty, trigger: 'Manual' },
      { id: '4', ...empty },
    ];
    const { shown, emptyCount } = splitEmptyRuns(runs);
    expect(shown.map((r) => r.id)).toEqual(['1', '3']);
    expect(emptyCount).toBe(2);
  });

  it('an all-real list loses nothing, and an empty list is zero and zero', () => {
    expect(splitEmptyRuns([{ id: '1', ...empty, status: 'Running' }])).toEqual({ shown: [{ id: '1', ...empty, status: 'Running' }], emptyCount: 0 });
    expect(splitEmptyRuns([])).toEqual({ shown: [], emptyCount: 0 });
  });
});

describe('#1391 audit actor label', () => {
  it('names the person with their email', () => {
    expect(auditActorLabel({ actorUserId: 'u1', actor: { name: 'Pat Example', email: 'pat@example.test' } })).toEqual({ name: 'Pat Example', email: 'pat@example.test' });
  });

  it('a deleted account is said so, and the opaque id is never what is printed', () => {
    const label = auditActorLabel({ actorUserId: 'HGBSopaqueid', actor: null });
    expect(label).toEqual({ name: 'Deleted user', email: null });
    expect(JSON.stringify(label)).not.toContain('HGBSopaqueid');
  });
});

describe('#1391 AI (est.) column', () => {
  it('is hidden while every workspace is zero, including an empty list', () => {
    expect(showAiCostColumn([])).toBe(false);
    expect(showAiCostColumn([{ aiCostCents: 0 }, { aiCostCents: 0 }])).toBe(false);
  });

  it('appears as soon as any workspace has a non-zero figure', () => {
    expect(showAiCostColumn([{ aiCostCents: 0 }, { aiCostCents: 12 }])).toBe(true);
  });
});

describe('#1391 no ticket codes on /admin', () => {
  // Reads the page source with its comments removed: what is left is what a platform admin can see.
  const source = readFileSync(join(__dirname, '../app/admin/page.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  it('has the page source to look at (a guard that reads nothing passes for everything)', () => {
    expect(source).toContain('Cost &amp; margin');
    expect(source.length).toBeGreaterThan(5000);
  });

  it('shows no MN- codes and no #123-style ticket numbers', () => {
    expect(source.match(/\bMN-\d+[a-z]?/g) ?? []).toEqual([]);
    expect(source.match(/(?<![&\w])#\d{2,}/g) ?? []).toEqual([]);
  });

  it('names the sections plainly', () => {
    for (const name of ['Overview', 'Cost &amp; margin', 'Runs', 'Pack marketplace', 'Billing']) {
      expect(source, name).toContain(`>${name}</h2>`);
    }
  });
});
