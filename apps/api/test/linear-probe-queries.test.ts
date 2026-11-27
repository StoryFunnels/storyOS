import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  TEAMS_QUERY, TEAM_COMMENTS_QUERY, TEAM_ISSUES_QUERY, TEAM_ISSUE_COUNT_QUERY, TEAM_ISSUE_HISTORY_QUERY, TEAM_MEMBERS_QUERY, TEAM_STATES_QUERY,
} from '../src/integrations/linear.service';

/**
 * Ticket #1367 — scripts/linear-probe.mjs measures what the importer's queries COST, so it carries a copy of them. A copy that drifts
 * measures a query the import no longer sends. This pins the two together: change a query in linear.service.ts and this fails until the
 * probe's copy follows.
 */
describe('the probe sends the importer\'s own queries', () => {
  it('every importer query it measures is byte-for-byte the service\'s', async () => {
    const mod = (await import(/* @vite-ignore */ pathToFileURL(resolve(__dirname, '../../../scripts/linear-probe.mjs')).href)) as { QUERIES: Record<string, string> };
    expect(mod.QUERIES.teams).toBe(TEAMS_QUERY);
    expect(mod.QUERIES.teamIssues).toBe(TEAM_ISSUES_QUERY);
    expect(mod.QUERIES.teamIssueHistory).toBe(TEAM_ISSUE_HISTORY_QUERY);
    expect(mod.QUERIES.teamComments).toBe(TEAM_COMMENTS_QUERY);
    expect(mod.QUERIES.teamMembers).toBe(TEAM_MEMBERS_QUERY);
    expect(mod.QUERIES.teamStates).toBe(TEAM_STATES_QUERY);
    expect(mod.QUERIES.teamIssueCount).toBe(TEAM_ISSUE_COUNT_QUERY);
  });
});
