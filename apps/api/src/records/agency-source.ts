import type { ChangeSource } from '../db/schema';

/**
 * Ticket #1294 (narrows #1204; Otto's ruling on ticket #1205, 2026-11-11): GOLD MEANS AGENCY (ticket #831).
 *
 * `records.last_ai_change_at` is the last time an AGENT or an MCP connection changed the record. The stored write source decides:
 *
 *   agent       stamps - an agent-scoped token (a named agent acting as the member)
 *   mcp         stamps - an MCP connection, and an ordinary API token with no origin, which the auth guard records as `mcp`
 *                        (auth.guard.ts: "Unset origin = an ordinary PAT = mcp"), so a person scripting with a plain token cannot be
 *                        told apart from MCP and stamps
 *   automation  does NOT stamp - an automation is neutral (ticket #1206); the rule that runs it is the member's, not an agent's
 *   human       does NOT stamp - a web session, never a header (provenance is the credential, #357)
 *
 * This is the ONE place the rule lives. The stamp in RecordsService (create, update, restore), the recompute in migration 0131 and
 * the tests all read it; a new write path or a new `change_source` value must be decided HERE, never re-cased inline. Migration
 * SQL cannot import TypeScript, so test/last-ai-change.test.ts parses the `IN (...)` list out of 0131 and fails if it differs from
 * AGENCY_SOURCES.
 */
export const AGENCY_SOURCES = ['agent', 'mcp'] as const satisfies readonly ChangeSource[];

export const isAgencySource = (source: ChangeSource): boolean => (AGENCY_SOURCES as readonly ChangeSource[]).includes(source);
