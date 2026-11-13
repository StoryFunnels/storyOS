import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { AgentWakeSource, AgentWakeSourcesResponse } from '@storyos/schemas';
import { AccessService } from '../access/access.service';
import type { Db } from '../db/client';
import { DB } from '../db/db.module';
import { automations, databases, fields, selectOptions, spaces } from '../db/schema';
import { RecordsService } from '../records/records.service';
import type { Membership } from '../workspaces/workspace-access.guard';
import { AgentsService } from './agents.service';

/**
 * Ticket #1289 (Otto's ruling of 2026-11-12) — EVERYTHING that can start an agent, from one call: its agent triggers (records of the
 * Agent Triggers database, state or relation) and every automation rule with a `run_agent` action for it (record created / updated /
 * linked, a schedule, an inbound webhook). The agent page used to show only the first kind, and said "set in Automations" about the rest.
 *
 * Who may read it: a workspace admin, or the agent's MANAGER (its owner, `created_by`; ADR-0021 Q2). Any other caller gets the SAME 404
 * an unknown agent gets, so this endpoint is not an oracle for which agents exist. (The route's MinRole is `member`, so a guest is refused
 * by the guard before an agent id is looked at, identically for every id.)
 *
 * What it leaves out, deliberately:
 *  - a source on a database the CALLER cannot open: counted in `withheld_count`, never named (listing it would say it exists);
 *  - anything inside a SYSTEM database (the #1296 rule: a system database is named, never described): the database's name is shown, but
 *    no field or option label is resolved from it;
 *  - a rule's condition, its prompt, its other actions and its webhook token. A source says WHAT wakes the agent, not how the rule is built.
 * A reference to something deleted (a field, an option, a database) comes back with `name: null` rather than an id standing in for a name,
 * and a field or option is only ever resolved INSIDE the database the source names, so a forged id cannot read another database's labels.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE = 200;

interface DbInfo {
  id: string;
  name: string | null;
  spaceId: string | null;
  exists: boolean;
  isSystem: boolean;
}

@Injectable()
export class AgentWakeSourcesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly access: AccessService,
    private readonly agents: AgentsService,
    private readonly records: RecordsService,
  ) {}

  async list(membership: Membership, agentRef: string): Promise<AgentWakeSourcesResponse> {
    const { agent, triggersDbId } = await this.agents.readAgentRecord(membership.workspaceId, agentRef).catch(() => {
      throw new NotFoundException('Agent not found');
    });
    // The manager or an admin; everyone else is told the agent does not exist.
    if (membership.role !== 'admin' && agent.created_by !== membership.userId) throw new NotFoundException('Agent not found');

    const raw: Array<{ databaseId: string; build: (db: DbInfo, labels: Labels) => AgentWakeSource }> = [];

    // 1. Agent triggers: records of the Agent Triggers database that point at this agent.
    if (triggersDbId) {
      let cursor: string | undefined;
      do {
        const page = await this.records.list(triggersDbId, { limit: PAGE, cursor });
        for (const b of page.data) {
          const linked = (b.values['agent'] as Array<{ id: string }> | undefined) ?? [];
          if (!linked.some((l) => l.id === agent.id)) continue;
          const databaseId = typeof b.values['database'] === 'string' ? (b.values['database'] as string) : '';
          if (!UUID_RE.test(databaseId)) continue; // a binding with no database cannot wake anything and names nothing to show
          const stateField = strOrNull(b.values['state_field']);
          const stateOption = strOrNull(b.values['state_option']);
          const relationField = strOrNull(b.values['relation_field']);
          raw.push({
            databaseId,
            build: (db, labels) => ({
              kind: 'agent_trigger',
              id: b.id,
              binding: relationField ? 'relation' : 'state',
              database: dbOut(db),
              state_field: stateField ? { id: stateField, name: labels.field(stateField) } : null,
              state_option: stateOption ? { id: stateOption, name: labels.option(stateOption) } : null,
              relation_field: relationField ? { id: relationField, name: labels.field(relationField) } : null,
              human_gate: b.values['human_gate'] === true,
              enabled: b.values['enabled'] === true,
            }),
          });
        }
        cursor = page.next_cursor ?? undefined;
      } while (cursor);
    }

    // 2. Automation rules with a run_agent action for this agent. The action names it by uuid or public number (the same resolution a
    //    manual run uses), so both spellings count; the SQL prefilter only keeps rules that have ANY run_agent action.
    const rules = await this.db
      .select({ id: automations.id, databaseId: automations.databaseId, name: automations.name, enabled: automations.enabled, trigger: automations.trigger, actions: automations.actions })
      .from(automations)
      .innerJoin(databases, eq(databases.id, automations.databaseId))
      .where(and(eq(databases.workspaceId, membership.workspaceId), sql`${automations.actions} @> '[{"type":"run_agent"}]'::jsonb`));
    const mine = new Set([agent.id.toLowerCase(), ...(agent.number != null ? [String(agent.number)] : [])]);
    for (const r of rules) {
      const wakes = ((r.actions as Array<{ type?: string; agent?: unknown }> | null) ?? []).some(
        (a) => a?.type === 'run_agent' && typeof a.agent === 'string' && mine.has(a.agent.trim().toLowerCase()),
      );
      if (!wakes) continue;
      const trig = (r.trigger ?? {}) as Record<string, unknown>;
      raw.push({
        databaseId: r.databaseId,
        build: (db, labels) => ({
          kind: 'automation',
          id: r.id,
          name: r.name,
          enabled: r.enabled,
          database: dbOut(db),
          trigger: automationTrigger(trig, labels),
        }),
      });
    }

    // Resolve the databases once, then the caller's access to them, then every label inside the databases that may be described.
    const dbIds = [...new Set(raw.map((r) => r.databaseId))];
    const infos = await this.databaseInfo(membership.workspaceId, dbIds);
    const visible = await this.visibleTo(membership, infos);
    const labelDbs = [...visible].filter((id) => infos.get(id)?.exists && !infos.get(id)?.isSystem);
    const labels = await this.labelsFor(labelDbs);

    const sources: AgentWakeSource[] = [];
    let withheld = 0;
    for (const r of raw) {
      const info = infos.get(r.databaseId) ?? { id: r.databaseId, name: null, spaceId: null, exists: false, isSystem: false };
      // A database that no longer exists has no access to check and nothing to protect: the source is shown as dangling.
      if (info.exists && !visible.has(r.databaseId)) {
        withheld += 1;
        continue;
      }
      sources.push(r.build(info, labels.for(r.databaseId)));
    }
    sources.sort((a, b) => rank(a) - rank(b) || label(a).localeCompare(label(b)) || a.id.localeCompare(b.id));
    return { agent_id: agent.id, sources, withheld_count: withheld };
  }

  /** Every named database (live or not), flagged. A personal-space database counts as not openable: it can never be described. */
  private async databaseInfo(workspaceId: string, ids: string[]): Promise<Map<string, DbInfo>> {
    const out = new Map<string, DbInfo>();
    if (!ids.length) return out;
    const rows = await this.db
      .select({ id: databases.id, name: databases.name, spaceId: databases.spaceId, isSystem: databases.isSystem, deletedAt: databases.deletedAt, personal: spaces.personal })
      .from(databases)
      .innerJoin(spaces, eq(spaces.id, databases.spaceId))
      .where(and(eq(databases.workspaceId, workspaceId), inArray(databases.id, ids)));
    for (const r of rows) {
      if (r.deletedAt) continue;
      out.set(r.id, { id: r.id, name: r.name, spaceId: r.personal ? null : r.spaceId, exists: true, isSystem: r.isSystem === true });
    }
    return out;
  }

  /** The ids of the databases the CALLER can open (a personal-space database never is). */
  private async visibleTo(membership: Membership, infos: Map<string, DbInfo>): Promise<Set<string>> {
    const live = [...infos.values()].filter((i) => i.exists && i.spaceId);
    const roles = await this.access.effectiveForDatabases(membership, live.map((i) => ({ id: i.id, spaceId: i.spaceId! })));
    return new Set(live.filter((i) => roles.get(i.id) != null).map((i) => i.id));
  }

  /** Field and option labels, keyed by the database they were read in: an id from elsewhere resolves to nothing. */
  private async labelsFor(databaseIds: string[]) {
    const fieldNames = new Map<string, Map<string, string>>();
    const optionLabels = new Map<string, Map<string, string>>();
    if (databaseIds.length) {
      const fieldRows = await this.db
        .select({ id: fields.id, databaseId: fields.databaseId, name: fields.displayName })
        .from(fields)
        .where(and(inArray(fields.databaseId, databaseIds), isNull(fields.deletedAt)));
      const owner = new Map<string, string>();
      for (const f of fieldRows) {
        owner.set(f.id, f.databaseId);
        (fieldNames.get(f.databaseId) ?? fieldNames.set(f.databaseId, new Map()).get(f.databaseId)!).set(f.id, f.name);
      }
      if (fieldRows.length) {
        const optionRows = await this.db
          .select({ id: selectOptions.id, fieldId: selectOptions.fieldId, label: selectOptions.label })
          .from(selectOptions)
          .where(inArray(selectOptions.fieldId, fieldRows.map((f) => f.id)));
        for (const o of optionRows) {
          const dbId = owner.get(o.fieldId);
          if (!dbId) continue;
          (optionLabels.get(dbId) ?? optionLabels.set(dbId, new Map()).get(dbId)!).set(o.id, o.label);
        }
      }
    }
    return {
      for: (databaseId: string): Labels => ({
        field: (id) => fieldNames.get(databaseId)?.get(id) ?? null,
        option: (id) => optionLabels.get(databaseId)?.get(id) ?? null,
      }),
    };
  }
}

interface Labels {
  field: (id: string) => string | null;
  option: (id: string) => string | null;
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null;
}

function dbOut(db: DbInfo) {
  return { id: db.id, name: db.exists ? db.name : null, exists: db.exists, is_system: db.isSystem };
}

function automationTrigger(trig: Record<string, unknown>, labels: Labels) {
  const type = (['record_created', 'record_updated', 'record_linked', 'schedule', 'webhook_received'] as const).find((t) => t === trig['type']) ?? 'record_updated';
  const fieldId = strOrNull(trig['field_id']);
  const relationId = strOrNull(trig['relation_field_id']);
  const direction: 'link' | 'unlink' | null = trig['direction'] === 'link' ? 'link' : trig['direction'] === 'unlink' ? 'unlink' : null;
  const schedule =
    type === 'schedule' && (['minutes', 'hour', 'day', 'week'] as const).includes(trig['every'] as never)
      ? {
          every: trig['every'] as 'minutes' | 'hour' | 'day' | 'week',
          ...(typeof trig['minutes'] === 'number' ? { minutes: trig['minutes'] } : {}),
          ...(typeof trig['at'] === 'string' ? { at: trig['at'] } : {}),
          ...(typeof trig['weekday'] === 'number' ? { weekday: trig['weekday'] } : {}),
          ...(Array.isArray(trig['weekdays']) ? { weekdays: (trig['weekdays'] as unknown[]).filter((n): n is number => typeof n === 'number') } : {}),
          ...(trig['between'] && typeof trig['between'] === 'object'
            ? { between: { from: String((trig['between'] as Record<string, unknown>)['from'] ?? ''), to: String((trig['between'] as Record<string, unknown>)['to'] ?? '') } }
            : {}),
          ...(typeof trig['timezone'] === 'string' ? { timezone: trig['timezone'] } : {}),
        }
      : null;
  return {
    type,
    field: type === 'record_updated' && fieldId ? { id: fieldId, name: labels.field(fieldId) } : null,
    relation_field: type === 'record_linked' && relationId ? { id: relationId, name: labels.field(relationId) } : null,
    direction: type === 'record_linked' ? direction : null,
    schedule,
  };
}

/** Agent triggers first (they are the agent's own), then rules; stable inside each. */
const rank = (s: AgentWakeSource) => (s.kind === 'agent_trigger' ? 0 : 1);
const label = (s: AgentWakeSource) => (s.kind === 'automation' ? s.name : (s.database.name ?? ''));
