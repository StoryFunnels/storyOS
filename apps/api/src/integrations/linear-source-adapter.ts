import { UnprocessableEntityException } from '@nestjs/common';
import type { SourceAdapter, SourceField, SourceRecord, SourceRelationLink } from '../migration-framework/types';
import { TEAM_QUERY, TEAMS_QUERY, defaultFetcher } from './linear.service';
import type { LinearFetcher, LinearTeam, LinearTeamData } from './linear.service';

export interface LinearSourceConfig {
  apiKey: string;
  /** Empty means "every team the API key can see" (matches LinearService.fetchTeams). */
  teamKeys: string[];
  /** Swappable for tests, same contract as LinearService.fetcher. */
  fetcher?: LinearFetcher;
}

/**
 * Linear source adapter (MN-066) — the framework's `SourceAdapter` (#198 /
 * ADR-0013) implemented for Linear's GraphQL API. `LinearService` still owns
 * the write path (dev-project-shaped databases, multi-pass relation linking)
 * because that's genuinely Linear-specific; this adapter is what the shared
 * dry-run/schema-discovery code calls to read Linear without duplicating the
 * GraphQL queries LinearService already has.
 */
export class LinearSourceAdapter implements SourceAdapter<LinearSourceConfig> {
  readonly key = 'linear';

  private apiKey = '';
  private fetcher: LinearFetcher = defaultFetcher;
  private teams: LinearTeam[] = [];
  private teamData = new Map<string, LinearTeamData>();

  async connect(config: LinearSourceConfig): Promise<void> {
    this.apiKey = config.apiKey;
    this.fetcher = config.fetcher ?? defaultFetcher;
    const data = (await this.fetcher(TEAMS_QUERY, {}, this.apiKey)) as { teams: { nodes: LinearTeam[] } };
    let teams = data.teams.nodes;
    if (config.teamKeys.length > 0) teams = teams.filter((t) => config.teamKeys.includes(t.key));
    if (teams.length === 0) {
      throw new UnprocessableEntityException('No Linear teams matched — check the team keys');
    }
    this.teams = teams;
  }

  /** The fixed shape of Linear's Issues container — Linear has no per-workspace
   * custom fields to discover, so this is a static schema rather than inferred. */
  readSchema(): SourceField[] {
    return [
      { key: 'state', label: 'State', sourceType: 'select' },
      { key: 'priority', label: 'Priority', sourceType: 'select' },
      { key: 'identifier', label: 'Identifier', sourceType: 'text' },
      { key: 'assignee_name', label: 'Assignee (name)', sourceType: 'text' },
      { key: 'estimate', label: 'Estimate', sourceType: 'number' },
      { key: 'url', label: 'URL', sourceType: 'url' },
    ];
  }

  private async fetchTeam(team: LinearTeam): Promise<LinearTeamData> {
    const cached = this.teamData.get(team.id);
    if (cached) return cached;
    const { team: data } = (await this.fetcher(TEAM_QUERY, { id: team.id }, this.apiKey)) as { team: LinearTeamData };
    this.teamData.set(team.id, data);
    return data;
  }

  /** Every issue/project/cycle/label across the connected teams, flattened into
   * source records tagged by `container` — relation targets are left for
   * `readRelations()`, matching the framework's "resolve relations separately" rule. */
  async readRecords(): Promise<SourceRecord[]> {
    const out: SourceRecord[] = [];
    for (const team of this.teams) {
      const data = await this.fetchTeam(team);
      for (const label of data.labels.nodes) {
        out.push({ sourceId: label.id, container: 'label', title: label.name, fields: { color: label.color } });
      }
      for (const cycle of data.cycles.nodes) {
        out.push({
          sourceId: cycle.id,
          container: 'sprint',
          title: cycle.name || `Cycle ${cycle.number}`,
          fields: { number: cycle.number, start_date: cycle.startsAt, end_date: cycle.endsAt },
        });
      }
      for (const project of data.projects.nodes) {
        out.push({
          sourceId: project.id,
          container: 'project',
          title: project.name,
          fields: { state: project.state, target_date: project.targetDate, url: project.url, description: project.description },
        });
      }
      for (const issue of data.issues.nodes) {
        out.push({
          sourceId: issue.id,
          container: 'issue',
          title: issue.title,
          fields: {
            identifier: issue.identifier,
            state: issue.state.name,
            priority: issue.priority,
            assignee_name: issue.assignee?.name ?? null,
            estimate: issue.estimate,
            url: issue.url,
          },
        });
      }
    }
    return out;
  }

  /** Parent/cycle/project/label edges — resolved in a later pass once every
   * record from `readRecords()` exists (Linear's parent can arrive before its child). */
  async readRelations(): Promise<SourceRelationLink[]> {
    const out: SourceRelationLink[] = [];
    for (const team of this.teams) {
      const data = await this.fetchTeam(team);
      for (const issue of data.issues.nodes) {
        if (issue.cycle) out.push({ fromSourceId: issue.id, fieldKey: 'sprint', toSourceIds: [issue.cycle.id] });
        if (issue.project) out.push({ fromSourceId: issue.id, fieldKey: 'project', toSourceIds: [issue.project.id] });
        if (issue.parent) out.push({ fromSourceId: issue.id, fieldKey: 'parent_issue', toSourceIds: [issue.parent.id] });
        if (issue.labels.nodes.length) {
          out.push({ fromSourceId: issue.id, fieldKey: 'labels', toSourceIds: issue.labels.nodes.map((l) => l.id) });
        }
      }
    }
    return out;
  }
}
