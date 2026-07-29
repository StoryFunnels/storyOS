import type { DatabaseSummary, Space } from './queries';

/**
 * #317: our own resources (databases, fields, select options) are Postgres
 * `uuid`s (`apps/api/src/db/schema.ts`). The agent-config entity-id fields
 * store these as plain text, so a bare id would otherwise leak into any generic
 * cell/panel renderer. We gate id-resolution on this shape so a *user's* own
 * text field that happens to be named `database` (holding e.g. "Postgres") is
 * never mistaken for a reference and rewritten.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function looksLikeUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value.trim());
}

/**
 * The agent-config text fields whose value is a *database* id (or, for
 * `target_databases`, a comma-joined list of them). Provisioned by
 * `AgentsService.ensurePack`: Agents.`target_databases`, Agent
 * Triggers.`database`.
 */
export const AGENT_DATABASE_REF_FIELDS = new Set(['target_databases', 'database']);
/**
 * The agent-config text fields whose value is a *field* id (`state_field`) or a
 * select-*option* id (`state_option`) living inside the trigger's target
 * database. Provisioned on the Agent Triggers database.
 */
export const AGENT_FIELD_REF_FIELDS = new Set(['state_field', 'state_option']);

/** Any agent-config field that stores a bare entity-id (see #317). */
export function isAgentConfigRefField(apiName: string): boolean {
  return AGENT_DATABASE_REF_FIELDS.has(apiName) || AGENT_FIELD_REF_FIELDS.has(apiName);
}

/**
 * Does a value carry a resolvable agent-config reference for this field? Guards
 * the special-case display so only genuine id payloads are rewritten. For
 * `target_databases` a comma-joined list counts if *every* segment is a UUID.
 */
export function isAgentConfigRefValue(apiName: string, value: unknown): boolean {
  if (!isAgentConfigRefField(apiName)) return false;
  if (apiName === 'target_databases') {
    if (typeof value !== 'string') return false;
    const parts = value.split(',').map((s) => s.trim()).filter(Boolean);
    return parts.length > 0 && parts.every((p) => looksLikeUuid(p));
  }
  return looksLikeUuid(value);
}

/** A minimal field shape for label resolution — decoupled from the web `Field`. */
export interface RefField {
  id: string;
  displayName: string;
  options?: Array<{ id: string; label: string }>;
}

/** Resolve a single database id to its qualified label, or flag it missing. */
export function resolveDatabaseId(
  id: string,
  databases: Array<Pick<DatabaseSummary, 'id' | 'name' | 'spaceId'>>,
  spaces: Array<Pick<Space, 'id' | 'name'>>,
): { id: string; label: string; missing: boolean } {
  const database = databases.find((item) => item.id === id);
  return database
    ? { id, label: qualifiedDatabaseLabel(database, spaces), missing: false }
    : { id, label: 'Unavailable database', missing: true };
}

/** Resolve a field id to its display name (searching a flat field list). */
export function resolveFieldLabel(
  fieldId: string,
  fields: RefField[],
): { label: string; missing: boolean } {
  const field = fields.find((f) => f.id === fieldId);
  return field
    ? { label: field.displayName, missing: false }
    : { label: 'Unavailable field', missing: true };
}

/** Resolve a select-option id to its label (searching every field's options). */
export function resolveOptionLabel(
  optionId: string,
  fields: RefField[],
): { label: string; missing: boolean } {
  for (const field of fields) {
    const option = field.options?.find((o) => o.id === optionId);
    if (option) return { label: option.label, missing: false };
  }
  return { label: 'Unavailable option', missing: true };
}

export function qualifiedDatabaseLabel(
  database: Pick<DatabaseSummary, 'name' | 'spaceId'>,
  spaces: Array<Pick<Space, 'id' | 'name'>>,
): string {
  const space = spaces.find((item) => item.id === database.spaceId);
  return space ? `${space.name} / ${database.name}` : database.name;
}

export function resolveDatabaseIds(
  value: unknown,
  databases: DatabaseSummary[],
  spaces: Space[],
): Array<{ id: string; label: string; missing: boolean }> {
  const ids = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : typeof value === 'string'
      ? value.split(',').map((item) => item.trim()).filter(Boolean)
      : [];
  return ids.map((id) => {
    const database = databases.find((item) => item.id === id);
    return database
      ? { id, label: qualifiedDatabaseLabel(database, spaces), missing: false }
      : { id, label: 'Unavailable database', missing: true };
  });
}

/**
 * #105: the inverse of `resolveDatabaseIds` for persisting an edited selection.
 * The agent `target_databases` field is a plain text field whose canonical
 * storage is a comma-and-space-joined id list (see `architect.service.ts`'s
 * `targets.join(', ')`), so the picker writes back in exactly that shape.
 * Empties collapse to `null` so a cleared field reads as unset, not "".
 */
export function serializeDatabaseIds(ids: string[]): string | null {
  return ids.length ? ids.join(', ') : null;
}
