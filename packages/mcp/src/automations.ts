/**
 * Automation-rule CRUD helpers (#334) — the human-readable ⇄ id translation that
 * lets an agent build a complete workflow over MCP without ever inventing a uuid.
 *
 * These are pure functions (no client, no network) so they're unit-testable in
 * isolation, exactly like mapFilterValues / buildIconCatalog in tools.ts. tools.ts
 * does the async orchestration (workspace/database resolution, fetching the target
 * database of a create_record action) and hands the already-fetched schema in here.
 *
 * The API (AutomationsService + AutomationActionsService.validate) stays the ONE
 * source of truth for validation — every reference these helpers cannot resolve
 * client-side (connections, agents, relation targets) is passed through untouched
 * and validated server-side, so there is no parallel validation path. A reference
 * these helpers CAN resolve but that names nothing real raises a structured error
 * (naming the valid options), surfaced by tools.ts's handle() as an isError result
 * — never a 500.
 */

/** The subset of a field's schema these helpers need (structurally compatible with
 * tools.ts's FieldDef and the API's describe_database field shape). */
export interface AutoField {
  id: string;
  apiName: string;
  displayName: string;
  type: string;
  options?: Array<{ id: string; label: string }>;
}

export interface AutoDetail {
  id: string;
  name: string;
  qualifiedSlug?: string;
  fields: AutoField[];
}

/**
 * Resolve one field reference — a uuid, api_name, or display name — to its field
 * def, optionally constrained to a set of types. Throws a structured error naming
 * the candidates when nothing matches, so the model self-corrects in one turn.
 */
export function findField(
  fields: AutoField[],
  ref: string,
  opts: { types?: string[]; kind?: string } = {},
): AutoField {
  const lower = String(ref).trim().toLowerCase();
  const typed = opts.types ? fields.filter((f) => opts.types!.includes(f.type)) : fields;
  const f = typed.find(
    (x) => x.id === ref || x.apiName.toLowerCase() === lower || x.displayName.toLowerCase() === lower,
  );
  if (f) return f;
  const kind = opts.kind ? `${opts.kind} ` : '';
  const avail = typed.map((x) => x.apiName).join(', ') || '(none)';
  throw new Error(`No ${kind}field matches "${ref}". Available: ${avail}.`);
}

/** Normalize a set_values map: keys given as a display name become the api_name,
 * and select/multi_select values given as a human label become the option id — the
 * same conveniences create_record already gives, so a set_values action reads and
 * writes in labels, not uuids. Unknown keys raise (validate() would 422 anyway, but
 * naming the field here is friendlier). rich_text markdown is NOT parsed here — the
 * automation engine interpolates {Field} tokens into these strings at run time. */
export function resolveValueMap(detail: AutoDetail, values: Record<string, unknown>): Record<string, unknown> {
  const byApi = new Map(detail.fields.map((f) => [f.apiName, f]));
  const byDisplay = new Map(detail.fields.map((f) => [f.displayName.toLowerCase(), f]));
  const out: Record<string, unknown> = {};
  for (const [rawKey, rawValue] of Object.entries(values)) {
    // `name` is the record-title shortcut every write accepts; keep it verbatim.
    const field = rawKey === 'name' ? undefined : byApi.get(rawKey) ?? byDisplay.get(rawKey.toLowerCase());
    const key = field ? field.apiName : rawKey;
    if (rawKey !== 'name' && !field && !byApi.has(rawKey)) {
      throw new Error(
        `set_values references unknown field "${rawKey}". Available: ${detail.fields.map((f) => f.apiName).join(', ') || '(none)'}.`,
      );
    }
    let value = rawValue;
    if (field?.options?.length) {
      const toId = (v: unknown) => {
        if (typeof v !== 'string') return v;
        const o = field!.options!.find((x) => x.id === v || x.label.toLowerCase() === v.toLowerCase());
        return o ? o.id : v;
      };
      if (field.type === 'select') value = toId(rawValue);
      else if (field.type === 'multi_select' && Array.isArray(rawValue)) value = rawValue.map(toId);
    }
    out[key] = value;
  }
  return out;
}

/** The trigger shape as the model may write it — human aliases (`field`,
 * `relation_field`) sit alongside the API's own `field_id`/`relation_field_id`. */
export interface TriggerInput {
  type: string;
  field?: string;
  field_id?: string;
  /** #334: what list_automations/get_automation PRINT back — accepted so a rule
   *  read out of the MCP can be passed straight back in without editing. */
  field_name?: string;
  relation_field?: string;
  relation_field_id?: string;
  relation_field_name?: string;
  /** #270/#297: fire only when records are LINKED, or only when UNLINKED. */
  direction?: string;
  every?: string;
  at?: string;
  weekday?: number;
}

const TRIGGER_TYPES = new Set([
  'record_created',
  'record_updated',
  'record_linked',
  'schedule',
  'webhook_received',
]);

/**
 * Build the API-shaped trigger from the model's input, resolving a field named by
 * `field`/`relation_field` to its id against this database's schema. `field_id`/
 * `relation_field_id` are accepted verbatim too (so a value read back from
 * get_automation round-trips). Structured errors on an unknown type or a
 * record_linked with no relation field.
 */
/**
 * #334 — first usable reference among the aliases. `??` alone is not enough:
 * get_automation echoes `field_name: null` when a rule watches every field, and
 * a null threaded into findField() would throw `No watched field matches "null"`
 * on a rule that is perfectly valid.
 */
function firstRef(...refs: Array<string | undefined | null>): string | undefined {
  for (const r of refs) if (typeof r === 'string' && r.trim() !== '') return r;
  return undefined;
}

export function buildAutomationTrigger(input: TriggerInput, detail: AutoDetail): Record<string, unknown> {
  if (!input || typeof input !== 'object' || typeof input.type !== 'string') {
    throw new Error('trigger must be an object with a "type".');
  }
  if (!TRIGGER_TYPES.has(input.type)) {
    throw new Error(`Unknown trigger type "${input.type}". One of: ${[...TRIGGER_TYPES].join(', ')}.`);
  }
  switch (input.type) {
    case 'record_created':
      return { type: 'record_created' };
    case 'record_updated': {
      // #334: field_name last — it is the human label this tool ECHOES, so a
      // caller round-tripping a rule sends it back and used to be ignored,
      // silently widening the rule to fire on every field change.
      const ref = firstRef(input.field, input.field_id, input.field_name);
      // Optional: an unqualified record_updated fires on ANY field change.
      if (ref === undefined) return { type: 'record_updated' };
      return { type: 'record_updated', field_id: findField(detail.fields, ref, { kind: 'watched' }).id };
    }
    case 'record_linked': {
      const ref = firstRef(input.relation_field, input.relation_field_id, input.relation_field_name);
      if (ref === undefined) throw new Error('record_linked trigger needs a "relation_field".');
      const t: Record<string, unknown> = {
        type: 'record_linked',
        relation_field_id: findField(detail.fields, ref, { types: ['relation'], kind: 'relation' }).id,
      };
      // #297: this used to be DROPPED. Silently, which is the worst version:
      // an agent asks for "when an Issue is UNLINKED, do X", gets a success
      // receipt, and the saved rule also fires on LINK — running emails/webhooks
      // at exactly the moments the author excluded. Validated rather than passed
      // through raw so a typo is an error, not a rule that fires on both.
      if (input.direction !== undefined && input.direction !== null) {
        if (input.direction !== 'link' && input.direction !== 'unlink') {
          throw new Error(`record_linked "direction" must be "link" or "unlink" (got ${JSON.stringify(input.direction)}). Omit it to fire on both.`);
        }
        t.direction = input.direction;
      }
      return t;
    }
    case 'schedule': {
      if (!input.every) throw new Error('schedule trigger needs "every" (hour | day | week).');
      const t: Record<string, unknown> = { type: 'schedule', every: input.every };
      if (input.at !== undefined) t.at = input.at;
      if (input.weekday !== undefined) t.weekday = input.weekday;
      return t;
    }
    default:
      return { type: 'webhook_received' };
  }
}

/**
 * Resolve the OWN-database field references inside one action (everything except
 * create_record, whose target-database refs tools.ts resolves async and passes in
 * via `overrides`). Everything not named here — send_webhook, send_slack_message,
 * add_comment, send_email, http_request auth, run_agent — is returned untouched for
 * the API to validate. Returns a NEW action object; never mutates the input.
 */
export function resolveActionFieldRefs(
  action: Record<string, unknown>,
  detail: AutoDetail,
): Record<string, unknown> {
  const type = action.type;
  if (type === 'set_values') {
    return { ...action, values: resolveValueMap(detail, (action.values as Record<string, unknown>) ?? {}) };
  }
  if (type === 'update_linked') {
    const ref = (action.relation_field ?? action.relation_field_id) as string | undefined;
    if (ref === undefined) throw new Error('update_linked action needs a "relation_field".');
    const rest = { ...action };
    delete rest.relation_field;
    return { ...rest, relation_field_id: findField(detail.fields, ref, { types: ['relation'], kind: 'relation' }).id };
  }
  if (type === 'notify_user') {
    const ref = action.user as string | undefined;
    if (ref && ref !== '@me' && ref !== 'me') {
      // A person field, addressed by name or api_name; @me stays verbatim.
      action = { ...action, user: findField(detail.fields, ref, { types: ['user'], kind: 'person' }).apiName };
    }
    return { ...action };
  }
  if (type === 'http_request' && Array.isArray(action.capture)) {
    const capture = (action.capture as Array<Record<string, unknown>>).map((c) => {
      const ref = (c.target_field ?? c.target_field_id) as string | undefined;
      if (ref === undefined) throw new Error('http_request capture needs a "target_field".');
      const rest = { ...c };
      delete rest.target_field;
      return { ...rest, target_field_id: findField(detail.fields, ref, { kind: 'capture-target' }).id };
    });
    return { ...action, capture };
  }
  return { ...action };
}

/**
 * Read-side annotation (get_automation / list_automations): inject sibling
 * `*_name` keys next to every id-bearing reference so the definition is
 * human-readable AND keeps the stable ids for a faithful round-trip. Own-database
 * field ids resolve from `detail`; a create_record's target database id resolves
 * from `databaseNamesById` (the workspace's database list). Best-effort — an id
 * that resolves to nothing (a stale reference to a deleted field) is left as-is
 * with a `*_name` of null, which is itself the signal that it's dangling.
 */
export function annotateTrigger(
  trigger: Record<string, unknown> | null | undefined,
  detail: AutoDetail,
): Record<string, unknown> | null | undefined {
  if (!trigger || typeof trigger !== 'object') return trigger;
  const byId = new Map(detail.fields.map((f) => [f.id, f]));
  const out = { ...trigger };
  if (typeof trigger.field_id === 'string') out.field_name = byId.get(trigger.field_id)?.displayName ?? null;
  if (typeof trigger.relation_field_id === 'string')
    out.relation_field_name = byId.get(trigger.relation_field_id)?.displayName ?? null;
  return out;
}

export function annotateActions(
  actions: unknown,
  detail: AutoDetail,
  databaseNamesById: Map<string, string> = new Map(),
): unknown {
  if (!Array.isArray(actions)) return actions;
  const byId = new Map(detail.fields.map((f) => [f.id, f]));
  return actions.map((raw) => {
    if (!raw || typeof raw !== 'object') return raw;
    const a = { ...(raw as Record<string, unknown>) };
    if (typeof a.relation_field_id === 'string') a.relation_field_name = byId.get(a.relation_field_id)?.displayName ?? null;
    if (typeof a.database_id === 'string') a.database_name = databaseNamesById.get(a.database_id) ?? null;
    if (typeof a.link_via_relation_field_id === 'string')
      a.link_via_relation_field_name = byId.get(a.link_via_relation_field_id)?.displayName ?? null;
    if (Array.isArray(a.capture)) {
      a.capture = (a.capture as Array<Record<string, unknown>>).map((c) =>
        typeof c.target_field_id === 'string'
          ? { ...c, target_field_name: byId.get(c.target_field_id)?.displayName ?? null }
          : c,
      );
    }
    return a;
  });
}

/** A single automation row (drizzle read shape) as the API returns it. */
export interface AutomationRow {
  id: string;
  name: string;
  enabled: boolean;
  trigger: Record<string, unknown>;
  condition: unknown;
  actions: unknown;
  failureStreak?: number;
  nextDueAt?: string | null;
  createdBy?: string | null;
  hookToken?: string | null;
  [k: string]: unknown;
}

export interface LastRun {
  status: string;
  error?: string | null;
  created_at?: string | null;
  duration_ms?: number | null;
}

/**
 * The curated, human-readable read shape for one rule. Deliberately does NOT spread
 * the whole row: hookSecret / lastHookPayload never leave the API this way (a read
 * token that reaches this far still shouldn't see a signing secret). The inbound
 * webhook URL is reconstructed from the token when present, so an agent that builds
 * a webhook_received rule can hand the URL to whatever will call it.
 */
export function readableAutomation(
  row: AutomationRow,
  detail: AutoDetail,
  opts: { databaseNamesById?: Map<string, string>; lastRun?: LastRun | null; workspaceSlug?: string; webOrigin?: string } = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    database: detail.qualifiedSlug ?? detail.name,
    trigger: annotateTrigger(row.trigger, detail),
    condition: row.condition ?? null,
    actions: annotateActions(row.actions, detail, opts.databaseNamesById ?? new Map()),
    failure_streak: row.failureStreak ?? 0,
    next_due_at: row.nextDueAt ?? null,
    created_by: row.createdBy ?? null,
  };
  if (opts.lastRun !== undefined) out.last_run = opts.lastRun;
  if (row.hookToken && opts.workspaceSlug) {
    const origin = opts.webOrigin ?? 'https://app.storyos.dev';
    out.webhook_url = `${origin}/api/v1/hooks/${opts.workspaceSlug}/${row.hookToken}`;
  }
  return out;
}
