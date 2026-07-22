import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { databases, fields as fieldsTable, selectOptions, workspaces } from '../db/schema';
import { RecordsService } from '../records/records.service';
import type { ProjectedRecord } from '../records/records.service';

export interface AdminRunSummary {
  id: string;
  number: number | null;
  title: string;
  workspaceId: string;
  workspaceName: string;
  agent: { id: string; title: string } | null;
  status: string | null;
  runClass: string | null;
  trigger: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

/**
 * How many runs are read per workspace's Runs database on each call. Every
 * workspace with a Runs database is scanned on every request (there is no
 * shared runs table to page across, see the class doc below), so an
 * unbounded per-workspace page would let one workspace's run volume drown
 * out the rest of the instance-wide view. Fine at today's scale — the same
 * caveat AdminOverviewService's own per-workspace loop already carries —
 * revisit with real pagination before either workspace count or per-workspace
 * run volume gets large.
 */
const RUNS_PER_WORKSPACE_LIMIT = 200;

/**
 * Cross-workspace runs read (#300, MN-216c) — the superadmin half of #209's
 * per-workspace Runs database. ADR-0010 §1 made a run an ordinary record in
 * the workspace's own "Runs" system database rather than a bespoke drizzle
 * table, so there is no single table to query across workspaces. This finds
 * every workspace's Runs database by name — the same cross-workspace
 * aggregation shape AdminOverviewService uses for its counts — then projects
 * each workspace's records through RecordsService (the same records API the
 * in-workspace runs surface reads, so the Agent relation chip and value
 * projection are never reimplemented here).
 *
 * Read-only, mirroring AdminOverviewService: the only mutation this ticket
 * adds — the cancel kill-switch — lives on AgentsService itself
 * (`adminCancelRun`), next to the same status-id lookup and run resolution
 * every other run mutation already uses.
 */
@Injectable()
export class AdminRunsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly recordsService: RecordsService,
  ) {}

  /** id → label for a select field on a database, read straight off schema. */
  private async optionLabels(databaseId: string, apiName: string): Promise<Map<string, string>> {
    const field = await this.db.query.fields.findFirst({
      where: and(eq(fieldsTable.databaseId, databaseId), eq(fieldsTable.apiName, apiName)),
    });
    if (!field) return new Map();
    const options = await this.db.query.selectOptions.findMany({
      where: eq(selectOptions.fieldId, field.id),
    });
    return new Map(options.map((o) => [o.id, o.label]));
  }

  private label(map: Map<string, string>, id: unknown): string | null {
    return typeof id === 'string' ? (map.get(id) ?? null) : null;
  }

  async listRuns(): Promise<AdminRunSummary[]> {
    const runsDatabases = await this.db
      .select({
        runsDbId: databases.id,
        workspaceId: databases.workspaceId,
        workspaceName: workspaces.name,
      })
      .from(databases)
      .innerJoin(workspaces, eq(workspaces.id, databases.workspaceId))
      .where(eq(databases.name, 'Runs'));

    const perWorkspace = await Promise.all(
      runsDatabases.map(async (row) => {
        const [statusLabels, triggerLabels, runClassLabels, page] = await Promise.all([
          this.optionLabels(row.runsDbId, 'status'),
          this.optionLabels(row.runsDbId, 'trigger'),
          this.optionLabels(row.runsDbId, 'run_class'),
          this.recordsService.list(row.runsDbId, { limit: RUNS_PER_WORKSPACE_LIMIT }),
        ]);

        return page.data.map((run: ProjectedRecord): AdminRunSummary => {
          const agentChip = (
            run.values['agent'] as Array<{ id: string; title: string }> | undefined
          )?.[0];
          return {
            id: run.id,
            number: run.number,
            title: run.title,
            workspaceId: row.workspaceId,
            workspaceName: row.workspaceName,
            agent: agentChip ? { id: agentChip.id, title: agentChip.title } : null,
            status: this.label(statusLabels, run.values['status']),
            runClass: this.label(runClassLabels, run.values['run_class']),
            trigger: this.label(triggerLabels, run.values['trigger']),
            startedAt: (run.values['started_at'] as string | undefined) ?? null,
            finishedAt: (run.values['finished_at'] as string | undefined) ?? null,
          };
        });
      }),
    );

    // Most recent first, across every workspace — a run with no started_at
    // (shouldn't happen post-dispatch, but schema drift is cheap insurance)
    // sorts last rather than crashing the comparator.
    return perWorkspace.flat().sort((a, b) => {
      const at = a.startedAt ? Date.parse(a.startedAt) : 0;
      const bt = b.startedAt ? Date.parse(b.startedAt) : 0;
      return bt - at;
    });
  }
}
