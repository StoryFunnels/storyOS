/**
 * Ticket #982 — the decisions an Architect build / pack install makes against a database that ALREADY EXISTS, as pure functions.
 *
 * Install walks a plan against live state and, per item, decides: create it, reuse what is there, or refuse. The pack preview has to
 * tell a person what that walk is going to do to a reused database ("adds the Budget field") BEFORE it does it. Two readings of the same
 * rules would drift, so there is one reading: `ArchitectService` and `PacksService` call these functions to decide, and the preview calls
 * the same functions to describe. A test installs after previewing and compares the preview with what actually changed.
 */

const norm = (s: string) => s.trim().toLowerCase();

/**
 * #1166 — is this a SYSTEM database (Members, Agents, Agent Triggers, Agent Runs, or any other the product provisions)? By the `is_system`
 * flag (and `system_key`, which only a system database can carry), NEVER by name (ADR-0017): a user's or a pack's own database called
 * "Members" is an ordinary one. The ONE question every place that matches a database for a pack install asks, so a pack never matches,
 * reuses, adopts or writes into one however it is asked.
 */
export const isSystemDatabase = (d: { isSystem?: boolean | null; systemKey?: string | null }): boolean => Boolean(d.isSystem || d.systemKey);

/** The part of a live field these decisions read. */
export interface DecidableField {
  displayName: string;
  type: string;
  options?: Array<{ label: string }>;
}

export type FieldDecision =
  /** No field of that name: it will be added. */
  | { action: 'create' }
  /** A field of that name is there: it is reused as it is. `clash` is set when its TYPE is not the one the plan wants (the plan's type is NOT applied). */
  | { action: 'reuse'; clash?: { live_type: string; planned_type: string } };

/** Add a planned field unless one of that display name is already there; a same-named field of another type is kept, and that is a clash worth saying. */
export function decideField(live: DecidableField[], plannedName: string, plannedType: string): FieldDecision {
  const existing = live.find((f) => norm(f.displayName) === norm(plannedName));
  if (!existing) return { action: 'create' };
  return existing.type === plannedType ? { action: 'reuse' } : { action: 'reuse', clash: { live_type: existing.type, planned_type: plannedType } };
}

export type StateDecision =
  | { action: 'create' }
  /** Reused: only the options it is missing are added (an existing option is never touched). */
  | { action: 'reuse'; options_to_add: string[] }
  /** A workflow state must be a select field; a same-named field of another type stops the whole install. */
  | { action: 'blocked'; live_type: string };

/** A workflow state is a select field with options; on a reused select only the missing options are added. */
export function decideState(live: DecidableField[], plannedField: string, plannedOptions: Array<{ label: string }>): StateDecision {
  const existing = live.find((f) => norm(f.displayName) === norm(plannedField));
  if (!existing) return { action: 'create' };
  if (existing.type !== 'select') return { action: 'blocked', live_type: existing.type };
  return { action: 'reuse', options_to_add: optionsMissing(existing.options, plannedOptions) };
}

/** The planned option labels that the field does not already have (case-insensitive, in plan order). */
export function optionsMissing(have: Array<{ label: string }> | undefined, planned: Array<{ label: string }>): string[] {
  const present = new Set((have ?? []).map((o) => norm(o.label)));
  return planned.filter((o) => !present.has(norm(o.label))).map((o) => o.label);
}

/** A relation is identified by its field on the "from" side: if that relation field is there the relation exists and is reused. */
export function relationExists(liveFromFields: DecidableField[], fromField: string): boolean {
  return liveFromFields.some((f) => f.type === 'relation' && norm(f.displayName) === norm(fromField));
}

/**
 * ticket #1222 - the words for a same-named field of another type that the install keeps as it is (the field is reported `reused`, with this
 * as its reason). Shared by the install result and the preview so the two say the same thing.
 */
export const fieldKeptReason = (fieldName: string, clash: { live_type: string; planned_type: string }): string =>
  `A "${fieldName}" field already exists as ${clash.live_type}; the pack wants ${clash.planned_type}, so it is kept as it is.`;

export type RelationDecision =
  /** The relation field is already there: reused as it is. */
  | { action: 'reuse' }
  /** Neither side has a field of that name: the relation is created. */
  | { action: 'create' }
  /** A same-named field that is not a relation sits where the relation's field would go: the install stops, naming the field and why. */
  | { action: 'blocked'; reason: string };

/**
 * ticket #1222 - what an install does with a planned relation against live state. The relation is identified by its field on the "from"
 * side (`relationExists`). A relation needs a free name on BOTH sides, and creating it over a field the person made is a raw "a field named X
 * already exists" from deep inside the relation service, found only mid-install. This says which field, on which database, and what it is.
 */
export function decideRelation(
  from: { name: string; fields: DecidableField[]; field: string },
  to: { name: string; fields: DecidableField[] | undefined; field: string | undefined },
): RelationDecision {
  if (relationExists(from.fields, from.field)) return { action: 'reuse' };
  const clash = (db: string, fields: DecidableField[] | undefined, name: string | undefined) => {
    const hit = name ? fields?.find((f) => norm(f.displayName) === norm(name)) : undefined;
    return hit
      ? `"${db}.${name}" already exists as a ${hit.type} field, but the pack needs a relation field there. Rename or remove it, or install the pack onto a database without it.`
      : undefined;
  };
  const reason = clash(from.name, from.fields, from.field) ?? clash(to.name, to.fields, to.field);
  return reason ? { action: 'blocked', reason } : { action: 'create' };
}
