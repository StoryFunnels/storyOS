import { describe, expect, it } from 'vitest';
import {
  findDriftPairing,
  missingLinks,
  normalizeLabel,
} from '../src/relations/select-relation-drift';
import type { SelectFieldRow, SelectOptionRow } from '../src/relations/select-relation-drift';

/**
 * MN-286: reproduces the exact scenario that surfaced the bug — Issues has a
 * `project` select field AND an `epic` relation to Projects; nothing keeps
 * them synced. These are pure, DB-free checks of the matching core.
 */

const projectField: SelectFieldRow = { id: 'f-project', apiName: 'project', displayName: 'Project' };
const areaField: SelectFieldRow = { id: 'f-area', apiName: 'area', displayName: 'Area' };

const options: SelectOptionRow[] = [
  { id: 'opt-mcp', fieldId: 'f-project', label: 'MCP API' },
  { id: 'opt-db', fieldId: 'f-project', label: 'Databases & Fields' },
  { id: 'opt-relations', fieldId: 'f-area', label: 'Relations' },
];

describe('normalizeLabel', () => {
  it('trims and lowercases', () => {
    expect(normalizeLabel('  MCP API  ')).toBe('mcp api');
  });
});

describe('findDriftPairing', () => {
  it('finds the select field/option pair matching the parent title, case/whitespace-insensitively', () => {
    const pairing = findDriftPairing([projectField, areaField], options, '  mcp api ');
    expect(pairing).toEqual({ field: projectField, option: { id: 'opt-mcp', label: 'MCP API' } });
  });

  it('returns null when the parent title matches nothing', () => {
    expect(findDriftPairing([projectField, areaField], options, 'Onboarding')).toBeNull();
  });

  it('returns null for a blank title — never treat "no title" as a match', () => {
    expect(findDriftPairing([projectField], options, '   ')).toBeNull();
  });

  it('checks fields in order and returns the first match', () => {
    // Both fields could in principle carry a matching label; the first field
    // in the list wins deterministically rather than picking arbitrarily.
    const dupOptions: SelectOptionRow[] = [...options, { id: 'opt-relations-2', fieldId: 'f-project', label: 'Relations' }];
    const pairing = findDriftPairing([projectField, areaField], dupOptions, 'Relations');
    expect(pairing?.field).toBe(projectField);
  });
});

describe('missingLinks', () => {
  const candidates = [
    { id: 'issue-27', title: 'Issue 27' },
    { id: 'issue-40', title: 'Issue 40' },
    { id: 'issue-71', title: 'Issue 71' },
  ];

  it('filters out already-linked ids, keeping the rest', () => {
    const linked = new Set(['issue-40']);
    expect(missingLinks(candidates, linked).map((c) => c.id)).toEqual(['issue-27', 'issue-71']);
  });

  it('returns everything when nothing is linked yet', () => {
    expect(missingLinks(candidates, new Set())).toHaveLength(3);
  });

  it('returns nothing when every candidate is already linked (no drift)', () => {
    const linked = new Set(candidates.map((c) => c.id));
    expect(missingLinks(candidates, linked)).toEqual([]);
  });
});
