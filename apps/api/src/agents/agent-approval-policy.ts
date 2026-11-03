import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Db } from '../db/client';
import { databases, fields, records, selectOptions } from '../db/schema';

/**
 * #1174 — the agent's `approval_policy` labels (delete | webhook | email | run_button | outward), read straight from its record.
 * Dependency-free like agent-identity.ts: the automation engine needs it on the RUNNER path (a run credential's write fired a
 * rule), and AgentsService, where the server-run path reads it, cannot be imported from there without a module cycle.
 */
export async function loadAgentApprovalPolicy(db: Db, workspaceId: string, agentId: string): Promise<Set<string>> {
  const [row] = await db
    .select({ values: records.values, fieldId: fields.id })
    .from(records)
    .innerJoin(databases, and(eq(databases.id, records.databaseId), eq(databases.workspaceId, workspaceId), eq(databases.isSystem, true), eq(databases.systemKey, 'agents')))
    .innerJoin(fields, and(eq(fields.databaseId, databases.id), eq(fields.apiName, 'approval_policy')))
    .where(and(eq(records.id, agentId), isNull(records.deletedAt)))
    .limit(1);
  if (!row) return new Set();
  const ids = ((row.values as Record<string, unknown>)[row.fieldId] as unknown[] | undefined) ?? [];
  if (!Array.isArray(ids) || ids.length === 0) return new Set();
  const options = await db
    .select({ label: selectOptions.label })
    .from(selectOptions)
    .where(and(eq(selectOptions.fieldId, row.fieldId), inArray(selectOptions.id, ids as string[])));
  return new Set(options.map((o) => o.label));
}
