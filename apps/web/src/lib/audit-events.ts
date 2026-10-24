/**
 * #1059 — the audit log's structural events: a space, database or view deleted, restored, restricted or unrestricted
 * (`<kind>.<action>`, the object in `payload.object`, API PR #1250). Rendered as a sentence an admin can read ("deleted the
 * database Leads") and filterable by what happened.
 *
 * `purged` is in the API's vocabulary but nothing emits it today (every delete is a soft delete). This page therefore claims
 * no permanent removal: it says exactly what the event says, and renders a `purged` event as "purged" if one ever arrives.
 */
const KINDS = ['space', 'database', 'view'] as const;
const ACTIONS = ['deleted', 'restored', 'purged', 'restricted', 'unrestricted'] as const;
type Kind = (typeof KINDS)[number];
type Action = (typeof ACTIONS)[number];

const types = (actions: readonly Action[]) => KINDS.flatMap((k) => actions.map((a) => `${k}.${a}`)).join(',');

/** The Type filter: value is the API's `type` comma list (empty = no filter). */
export const AUDIT_TYPE_FILTERS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: 'All activity' },
  { value: types(ACTIONS), label: 'Spaces, databases and views: everything' },
  { value: types(['deleted']), label: 'Deleted' },
  { value: types(['restored']), label: 'Restored' },
  { value: types(['restricted', 'unrestricted']), label: 'Restricted or opened to everyone' },
];

export interface StructuralEvent {
  kind: Kind;
  action: Action;
  name: string;
  /** The sentence after the actor: "deleted the database", then the name is drawn bold by the caller. */
  verb: string;
  noun: string;
  /** A fact the event carries about what else changed, or where the object lived. */
  detail: string | null;
}

const asRecord = (v: unknown): Record<string, unknown> => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const VERBS: Record<Action, string> = {
  deleted: 'deleted',
  restored: 'restored',
  purged: 'purged',
  restricted: 'restricted',
  unrestricted: 'opened to everyone',
};

/** The structural event behind an audit entry, or null for anything else (a record event, a field change, an unknown type). */
export function describeStructuralEvent(type: string | undefined, payload: unknown): StructuralEvent | null {
  const [kind, action] = (type ?? '').split('.') as [Kind, Action];
  if (!KINDS.includes(kind) || !ACTIONS.includes(action)) return null;
  const p = asRecord(payload);
  const object = asRecord(p.object);
  const name = typeof object.name === 'string' && object.name.trim() ? object.name : '(unnamed)';

  let detail: string | null = null;
  if (kind === 'space' && action === 'deleted' && Array.isArray(p.databases_deleted) && p.databases_deleted.length > 0) {
    const names = p.databases_deleted.map((d) => asRecord(d).name).filter((n): n is string => typeof n === 'string');
    detail = `Took ${plural(p.databases_deleted.length, 'database', 'databases')} with it${names.length ? `: ${names.join(', ')}` : ''}`;
  } else if (kind === 'space' && action === 'restored' && typeof p.databases_restored === 'number' && p.databases_restored > 0) {
    detail = `${plural(p.databases_restored, 'database', 'databases')} came back with it`;
  } else if (kind === 'database' && action === 'deleted' && typeof p.severed_relations === 'number' && p.severed_relations > 0) {
    detail = `${plural(p.severed_relations, 'relation', 'relations')} to it ${p.severed_relations === 1 ? 'was' : 'were'} severed`;
  } else if (kind === 'view') {
    if (typeof p.database_name === 'string') detail = `in the database ${p.database_name}`;
    else if (typeof p.space_name === 'string') detail = `in the space ${p.space_name}`;
  }
  return { kind, action, name, verb: VERBS[action], noun: kind, detail };
}
