import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { databases as databasesTable } from '../db/schema';
import { DatabasesService } from '../databases/databases.service';
import { FieldsService } from '../fields/fields.service';
import { SpacesService } from '../workspaces/spaces.service';
import type { Membership } from '../workspaces/workspace-access.guard';

/**
 * Agents system database (MN-214a, ADR-0010 — docs/decisions/ADR-0010-agentic-os-engine.md).
 *
 * The keystone of the Agentic OS foundation: an agent is a first-class *record*
 * in an ordinary StoryOS database, not a bespoke drizzle table. Making agents
 * records means views, filters, comments, permissions and export all work on
 * them for free (ADR-0010 §1). This service provisions that database the same
 * way the GitHub integration provisions its pack — idempotently, found-by-name,
 * with no migration.
 */
@Injectable()
export class AgentsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly spaces: SpacesService,
    private readonly databasesService: DatabasesService,
    private readonly fields: FieldsService,
  ) {}

  /** The Agents database, if it has been provisioned for this workspace. */
  private async findAgentsDb(workspaceId: string) {
    const all = await this.db.query.databases.findMany({
      where: eq(databasesTable.workspaceId, workspaceId),
    });
    return all.find((d) => d.name === 'Agents');
  }

  /**
   * Find-or-create the "Agentic OS" space + "Agents" database and its fields.
   * Idempotent by database name: a second call returns the same database and
   * adds nothing (mirrors GithubService.ensurePack).
   */
  async ensurePack(membership: Membership): Promise<{ agentsDb: typeof databasesTable.$inferSelect; created: boolean }> {
    const existing = await this.findAgentsDb(membership.workspaceId);
    if (existing) return { agentsDb: existing, created: false };

    const allSpaces = await this.spaces.list(membership);
    const space =
      allSpaces.find((s) => s.name === 'Agentic OS') ??
      (await this.spaces.create(membership.workspaceId, { name: 'Agentic OS', icon: '🤖' }));

    const agentsDb = (await this.databasesService.create(membership, {
      space_id: space.id,
      name: 'Agents',
      icon: '🤖',
    })) as typeof databasesTable.$inferSelect;

    // The record title is the agent name (the auto title field). Everything else
    // is the agent's definition per ADR-0010 §1.
    const agentFields: Array<Parameters<FieldsService['create']>[1]> = [
      { display_name: 'Goal', type: 'rich_text', config: {} },
      { display_name: 'Instructions', type: 'rich_text', config: {} },
      {
        display_name: 'Scopes',
        type: 'multi_select',
        config: {},
        options: [
          { label: 'read', color: 'blue' },
          { label: 'write', color: 'orange' },
          { label: 'admin', color: 'red' },
        ],
      },
      {
        display_name: 'Trigger',
        type: 'select',
        config: {},
        // "Manual" is the default concept — the manual run ships before the
        // state/schedule runtimes exist (ADR-0010 §3).
        options: [
          { label: 'Manual', color: 'gray' },
          { label: 'State change', color: 'green' },
          { label: 'Schedule', color: 'purple' },
        ],
      },
      // TODO(#206): a relation to "databases" isn't possible while databases
      // aren't records, so target databases are stored as text (names/ids) for
      // now. Replace with a richer target-picker once databases are addressable.
      { display_name: 'Target databases', type: 'text', config: {} },
      {
        display_name: 'Approval policy',
        type: 'multi_select',
        config: {},
        options: [
          { label: 'delete', color: 'red' },
          { label: 'webhook', color: 'orange' },
          { label: 'email', color: 'gold' },
          { label: 'run_button', color: 'blue' },
          { label: 'outward', color: 'purple' },
        ],
      },
      { display_name: 'Enabled', type: 'checkbox', config: {} },
    ];
    for (const f of agentFields) await this.fields.create(agentsDb.id, f);

    return { agentsDb, created: true };
  }

  /**
   * Summary of the Agents database if it exists, else `{ exists: false }`.
   * Agent records themselves are read/created through the normal records API on
   * this database — this service does not duplicate record CRUD.
   */
  async getPack(membership: Membership): Promise<{ exists: true; id: string; name: string } | { exists: false }> {
    const agentsDb = await this.findAgentsDb(membership.workspaceId);
    if (!agentsDb) return { exists: false };
    return { exists: true, id: agentsDb.id, name: agentsDb.name };
  }
}
