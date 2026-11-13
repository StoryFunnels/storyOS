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
  /** The sentence after the actor: `<verb> the <noun> <name><suffix>`, the name drawn bold by the caller. */
  verb: string;
  noun: string;
  /** Only "opened … to everyone" reads on after the name. */
  suffix: string;
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
  unrestricted: 'opened',
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
  return { kind, action, name, verb: VERBS[action], noun: kind, suffix: action === 'unrestricted' ? ' to everyone' : '', detail };
}

/**
 * Ticket #1287 — what an audit row SAYS. One mapping from the API's event code to a person's sentence, so no row shows `record.updated`.
 *
 * A sentence is `lead`, then the bold `name` when the event honestly carries one, then `tail`, then a muted `detail`. The name is only
 * ever a name the event ITSELF carries (a title in its payload, an object's snapshot name): never a guess, never an id. The API does
 * not send a record's current title or database with an audit row (ticket #1287's gap, Marek's API), so a record event names its KIND of
 * event ("Record updated"), never a placeholder noun standing where a name will go.
 *
 * An event code this table has no case for is not hidden and not guessed at: "Something changed", with the code as muted detail.
 * `audit-events.unit.test.ts` derives every code the API can emit from its source and fails on one with no case here.
 */
export interface AuditSentence {
  lead: string;
  /** Drawn bold, in curly quotes, by the caller. */
  name: string | null;
  tail: string;
  /** Muted, after a middle dot. */
  detail: string | null;
  /** False only for a code with no case: the caller may style it as unexplained. */
  known: boolean;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const sentence = (lead: string, extra: Partial<Omit<AuditSentence, 'lead' | 'known'>> = {}): AuditSentence => ({
  lead,
  name: extra.name ?? null,
  tail: extra.tail ?? '',
  detail: extra.detail ?? null,
  known: true,
});

type PhraseFn = (payload: Record<string, unknown>) => AuditSentence;

const other = (p: Record<string, unknown>) => str(asRecord(p.other).title);

/** Every event type that is not a space/database/view structural event (those go through `describeStructuralEvent`). */
const PHRASES: Record<string, PhraseFn> = {
  'record.created': (p) => (str(p.title) ? sentence('Created', { name: str(p.title) }) : sentence('Record created')),
  'record.updated': () => sentence('Record updated'),
  'record.deleted': () => sentence('Record moved to Trash'),
  'record.restored': () => sentence('Record restored from Trash'),
  'relation.linked': (p) => (other(p) ? sentence('Linked to', { name: other(p) }) : sentence('Records linked')),
  'relation.unlinked': (p) => (other(p) ? sentence('Unlinked from', { name: other(p) }) : sentence('Records unlinked')),
  'comment.created': () => sentence('Comment added'),
  'reference.created': () => sentence('Mention added'),
  'document.edited': (p) => sentence(p.restored_from_version_id ? 'Earlier description version restored' : 'Description edited'),
  'attachment.added': (p) => sentence('Added an attachment', { name: str(p.filename) }),
  'button.pressed': (p) => (str(p.button) ? sentence('Pressed the button', { name: str(p.button) }) : sentence('Pressed a button')),
  'portal_recipient.created': (p) => sentence('Created a portal link for', { name: str(asRecord(p.object).name) }),
  'portal_recipient.rotated': (p) => sentence('Replaced the portal link for', { name: str(asRecord(p.object).name) }),
  'portal_recipient.revoked': (p) => sentence('Revoked the portal link for', { name: str(asRecord(p.object).name) }),
  'runner.paired': (p) => sentence('Paired the Runner', { name: str(asRecord(p.object).name) }),
  'runner.activated': (p) => sentence('Activated the Runner', { name: str(asRecord(p.object).name) }),
  'runner.assigned': (p) => sentence('Assigned an agent to the Runner', { name: str(asRecord(p.object).name) }),
  'runner.unassigned': (p) => sentence('Removed an agent from the Runner', { name: str(asRecord(p.object).name) }),
  'runner.revoked': (p) => sentence('Revoked the Runner', { name: str(asRecord(p.object).name) }),
  'outward.slack_mention_mirror': (p) => sentence('Mirrored a mention to Slack', { detail: str(p.summary) }),
  'outward.mention_email': (p) => sentence('Emailed a member about a mention', { detail: str(p.summary) }),
  'outward.watcher_email': (p) => sentence('Emailed a watcher about a change', { detail: str(p.summary) }),
  'outward.calendar_sync': (p) => sentence('Synced to the calendar', { detail: str(p.summary) }),
  'outward.linear_comment': (p) => sentence('Posted a comment to Linear', { detail: str(p.summary) }),
  'outward.ai_field': (p) => sentence('Recomputed an AI field', { detail: str(p.summary) }),
};

/** The non-structural event codes this table has a sentence for (the test compares it with what the API can emit). */
export const AUDIT_PHRASE_TYPES: readonly string[] = Object.keys(PHRASES);

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function describeAuditEvent(type: string | undefined, payload: unknown): AuditSentence {
  const structural = describeStructuralEvent(type, payload);
  if (structural) {
    return sentence(capitalise(`${structural.verb} the ${structural.noun}`), { name: structural.name, tail: structural.suffix, detail: structural.detail });
  }
  const phrase = type ? PHRASES[type] : undefined;
  if (phrase) return phrase(asRecord(payload));
  return { lead: 'Something changed', name: null, tail: '', detail: type ?? null, known: false };
}

/** The kinds and actions the web knows as structural: the test pins them to the API's own lists. */
export const STRUCTURAL_VOCABULARY = { kinds: KINDS, actions: ACTIONS } as const;
