import { Inject, Injectable, UnprocessableEntityException } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import type { AutomationAction, FormulaFieldInfo } from '@storyos/schemas';
// #342 — automations compute numbers through the SAME engine as formula fields,
// rather than a second expression language with its own quirks.
import { evaluateFormula, parseFormula } from '@storyos/schemas';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { connections, databases, fields, memberships, records, relations, user } from '../db/schema';
import { FieldsService } from '../fields/fields.service';
import { compileFilter } from '../records/query-compiler';
import type { FilterNode } from '@storyos/schemas';
import { CommentsService } from '../comments/comments.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { SlackService } from '../integrations/slack.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RecordsService } from '../records/records.service';
import type { ProjectedRecord } from '../records/records.service';
import { RelationsService } from '../relations/relations.service';
import { stringHeadersOnly } from '../common/webhook-headers';
import { getJsonPath } from '../common/json-path';
import { JobRunnerService, buildIdempotencyKey } from './job-runner.service';
import { ApprovalsService } from './approvals.service';

/** Full token match — `{payload.a.b.0}`, nothing else in the string. */
const PAYLOAD_VALUE_TOKEN_RE = /^\{payload\.([^{}]+)\}$/;

/** #244: full-value match — `{linked.Due Date}`, nothing else. Like the payload
 * form, a value that is entirely one linked token resolves to the underlying
 * TYPED field value (a date, number, relation array), not a stringified one. */
const LINKED_VALUE_TOKEN_RE = /^\{linked\.([^{}]+)\}$/;

/**
 * MN-254: the only actions that don't require a triggering record — safe to
 * run from a webhook_received rule. Everything else (set_values, add_comment,
 * update_linked) exists to write back to the record that fired the rule, and
 * a webhook delivery has none.
 */
const WEBHOOK_SAFE_ACTIONS = new Set([
  'create_record',
  'create_records',
  'send_slack_message',
  'send_webhook',
  'notify_user',
]);

/** MN-256: the connection provider ids a send_email action may reference. */
const MAIL_PROVIDER_IDS = new Set(['resend', 'smtp']);

/**
 * MN-256: `to`/`cc` are a single comma-separated template string (like
 * send_webhook's `url`, not a structured list) — split, trim, drop empties.
 * Not a validity check on its own; callers decide what "valid" means (a save-
 * time count/shape check in validate(), a real email-syntax check at send).
 */
function splitEmailAddresses(raw: string): string[] {
  return raw
    .split(',')
    .map((a) => a.trim())
    .filter((a) => a.length > 0);
}

export interface ActionContext {
  workspaceId: string;
  databaseId: string;
  /**
   * MN-254: null for a webhook_received rule — there is no triggering record,
   * only a delivered `payload`. Every action handler below that reads
   * `ctx.record` is one validate() already keeps off a webhook rule's action
   * list, so the non-null uses are guarded by that upstream check, not by a
   * runtime null check here.
   */
  record: ProjectedRecord | null;
  actorId: string;
  /** Loop-guard depth for automation-caused writes (MN-047). */
  depth?: number;
  /** MN-254: the inbound webhook body, addressable via {payload.a.b.0} tokens. */
  payload?: Record<string, unknown> | null;
  /** MN-254: set by runHookRule so validate()'s re-check applies the same restriction. */
  triggerType?: string;
  /** MN-253: absent when actions run outside a rule (none today — every caller
   * is a rule run — kept optional so a future non-rule caller isn't forced to
   * fabricate one). Feeds the job idempotency key and automation_jobs.rule_id. */
  ruleId?: string | null;
  /** MN-253: pre-minted by the caller (automations.service.ts) before actions
   * run, so a job enqueued mid-execute() can carry the SAME id its eventual
   * automationRuns row gets — see buildIdempotencyKey. */
  runId?: string;
  /**
   * #244: for a `record_linked` trigger, the specific record(s) just linked or
   * unlinked on the OTHER side of the relation — so an action can read their
   * fields via `{linked.Field}` instead of only the host record. The first
   * entry is the primary linked record. Empty/undefined for every other trigger.
   */
  linkedRecords?: ProjectedRecord[];
  /** #244: the database the `linkedRecords` live in — execute() resolves its
   * display-name → api-name map from this so `{linked.Status}` works the same
   * way `{Status}` does for the host record. */
  linkedDatabaseId?: string | null;
  /** #244: the relation field whose change fired this run. */
  changedRelationFieldId?: string | null;
  /** #270: whether that relation change was a link or an unlink (null for a
   * set-op / non-relation trigger). */
  changedRelationDirection?: 'link' | 'unlink' | null;
  /**
   * #273: a rendered "Field: from → to · …" line for the change that fired this
   * run, exposed as the `{changesSummary}` token. Undefined unless the rule's
   * actions reference the token (the caller resolves it lazily) or the trigger
   * carried no value diff.
   */
  changesSummary?: string;
  /** #244: display-name → api-name for `linkedDatabaseId`, populated by execute()
   * once per run (the linked record is in a different database than the host). */
  linkedDisplayToApi?: Map<string, string>;
  /** #246: 1-based position of the current record within a create_records batch,
   * exposed as the `{index}` token so each created record can differ. */
  itemIndex?: number;
}

/** #246 — hard ceiling on one create_records action, so a bad count can't spawn
 * an unbounded number of records. */
const MAX_BATCH_CREATE = 200;

export interface ActionEffect {
  type: string;
  record_id?: string;
  summary: string;
}

/**
 * MN-088: escape a value for the inside of a JSON string literal — JSON.stringify
 * then drop its outer quotes. Without this, a title with a `"` in it breaks the
 * body a user templated by hand.
 */
export function jsonEscape(value: string): string {
  const encoded = JSON.stringify(value);
  return encoded.slice(1, -1);
}

/** MN-088: a JSON body_template should reach the receiver as an object, not a string. */
export function parseTemplateBody(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return { body: raw };
  try {
    return JSON.parse(trimmed);
  } catch {
    return { body: raw };
  }
}

/**
 * The shared action executor (MN-046 buttons, MN-047 automations): declarative
 * primitives only. Tokens: @me / @now / @today in values; {Field Name}
 * interpolation in comment templates.
 */
@Injectable()
export class AutomationActionsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly recordsService: RecordsService,
    private readonly relationsService: RelationsService,
    private readonly commentsService: CommentsService,
    private readonly notificationsService: NotificationsService,
    private readonly slackService: SlackService,
    private readonly webhooksService: WebhooksService,
    private readonly jobs: JobRunnerService,
    private readonly approvals: ApprovalsService,
  ) {}

  /**
   * MN-256: true iff every address is an active workspace member's email —
   * the run-time check that lets a defaulted send_email approval gate skip
   * itself (execute()'s own doc comment). Case-insensitive; an empty address
   * list is never "all internal" by the caller's own guard (never called
   * with one).
   */
  private async allRecipientsInternal(workspaceId: string, addresses: string[]): Promise<boolean> {
    const rows = await this.db
      .select({ email: user.email })
      .from(memberships)
      .innerJoin(user, eq(memberships.userId, user.id))
      .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.status, 'active')));
    const memberEmails = new Set(rows.map((r) => r.email.toLowerCase()));
    return addresses.every((a) => memberEmails.has(a.toLowerCase()));
  }

  /** The related database + this record's linked ids through a relation field. */
  private async resolveLinked(
    databaseId: string,
    relationFieldId: string,
    record: ProjectedRecord,
  ): Promise<{ targetDbId: string; linkedIds: string[] } | null> {
    const field = await this.db.query.fields.findFirst({
      where: and(
        eq(fields.id, relationFieldId),
        eq(fields.databaseId, databaseId),
        isNull(fields.deletedAt),
      ),
    });
    if (!field || field.type !== 'relation') return null;
    const cfg = field.config as { relation_id: string; side: 'a' | 'b' };
    const relation = await this.db.query.relations.findFirst({
      where: eq(relations.id, cfg.relation_id),
    });
    if (!relation) return null;
    const targetDbId = cfg.side === 'a' ? relation.databaseBId : relation.databaseAId;
    const chips = (record.values[field.apiName] as Array<{ id: string }> | undefined) ?? [];
    return { targetDbId, linkedIds: chips.map((c) => c.id) };
  }

  /**
   * Save-time validation: every reference must exist right now. `triggerType`
   * additionally gates which actions a webhook_received rule may carry (MN-254)
   * — a rule with no triggering record cannot run an action whose only job is
   * to write back to one. `actorRole` (MN-256) is ONLY passed by an actual
   * save (automations.service.ts's create()/update()) — execute()'s own
   * re-validate and test()'s dry run both omit it, since "only an admin may
   * turn off send_email's approval gate" is a save-time rule, not a run-time
   * one (a rule already saved with `require_approval: false` keeps running
   * that way even if its creator is later demoted).
   */
  async validate(
    databaseId: string,
    workspaceId: string,
    actions: AutomationAction[],
    triggerType?: string,
    actorRole?: string,
  ): Promise<void> {
    const live = await this.db.query.fields.findMany({
      where: and(eq(fields.databaseId, databaseId), isNull(fields.deletedAt)),
    });
    const apiNames = new Set(live.map((f) => f.apiName));
    const isWebhookTrigger = triggerType === 'webhook_received';
    for (const action of actions) {
      if (isWebhookTrigger && !WEBHOOK_SAFE_ACTIONS.has(action.type)) {
        throw new UnprocessableEntityException(
          `"${action.type}" needs a triggering record — a webhook_received rule has none. ` +
            `Allowed actions here: ${[...WEBHOOK_SAFE_ACTIONS].join(', ')}.`,
        );
      }
      if (isWebhookTrigger && action.type === 'notify_user' && action.user !== '@me') {
        throw new UnprocessableEntityException(
          'notify_user on a webhook_received rule can only notify "@me" (the rule owner) — ' +
            'there is no triggering record to read a person field from.',
        );
      }
      if (action.type === 'set_values') {
        for (const key of Object.keys(action.values)) {
          if (key !== 'name' && !apiNames.has(key)) {
            throw new UnprocessableEntityException(`set_values references unknown field "${key}"`);
          }
        }
      }
      if (action.type === 'create_record' || action.type === 'create_records') {
        const target = await this.db.query.databases.findFirst({
          where: and(eq(databases.id, action.database_id), eq(databases.workspaceId, workspaceId)),
        });
        if (!target)
          throw new UnprocessableEntityException(`${action.type} targets an unknown database`);
        if (action.link_via_relation_field_id) {
          const relField = await this.db.query.fields.findFirst({
            where: and(
              eq(fields.id, action.link_via_relation_field_id),
              eq(fields.databaseId, action.database_id),
              isNull(fields.deletedAt),
            ),
          });
          if (!relField || relField.type !== 'relation') {
            throw new UnprocessableEntityException(
              'link_via_relation_field_id must be a relation field on the target database',
            );
          }
        }
      }
      if (action.type === 'notify_user') {
        if (action.user !== '@me') {
          const uf = live.find((f) => f.apiName === action.user);
          if (!uf || uf.type !== 'user') {
            throw new UnprocessableEntityException(
              'notify_user "user" must be @me or a person field',
            );
          }
        }
      }
      if (action.type === 'update_linked') {
        const relField = live.find((f) => f.id === action.relation_field_id);
        if (!relField || relField.type !== 'relation') {
          throw new UnprocessableEntityException(
            'update_linked relation_field_id must be a relation field on this database',
          );
        }
      }
      if (action.type === 'send_email') {
        const connection = await this.db.query.connections.findFirst({
          where: and(eq(connections.id, action.connection_id), eq(connections.workspaceId, workspaceId)),
        });
        if (!connection) {
          throw new UnprocessableEntityException('send_email references an unknown connection');
        }
        if (!MAIL_PROVIDER_IDS.has(connection.provider)) {
          throw new UnprocessableEntityException(
            `send_email's connection must be a Resend or SMTP connection (got "${connection.provider}")`,
          );
        }
        const scopes = (connection.scopes ?? []) as string[];
        if (!scopes.some((s) => s.startsWith('from:'))) {
          throw new UnprocessableEntityException(
            'This connection has no configured from-address yet — reconnect it with a from_address ' +
              '(and, for Resend, one on a verified domain) before using it in a send_email action.',
          );
        }
        // MN-256: only an admin may save a send_email action with the
        // approval gate explicitly turned off — a member can still turn it
        // ON (require_approval: true), or leave it at the default.
        if (action.require_approval === false && actorRole !== undefined && actorRole !== 'admin') {
          throw new UnprocessableEntityException(
            'Only a workspace admin can turn off approval for a send_email action.',
          );
        }
      }
      if (action.type === 'http_request') {
        if (action.connection_id) {
          const connection = await this.db.query.connections.findFirst({
            where: and(eq(connections.id, action.connection_id), eq(connections.workspaceId, workspaceId)),
          });
          if (!connection) {
            throw new UnprocessableEntityException('http_request connection_id is not a connection in this workspace');
          }
          if (connection.provider !== 'http') {
            throw new UnprocessableEntityException(
              `http_request connection_id must be an 'http' connection, not '${connection.provider}'`,
            );
          }
        }
        for (const capture of action.capture ?? []) {
          const targetField = live.find((f) => f.id === capture.target_field_id);
          if (!targetField) {
            throw new UnprocessableEntityException(
              `http_request capture targets an unknown field (${capture.target_field_id})`,
            );
          }
        }
      }
    }
  }

  private resolveTokens(
    values: Record<string, unknown>,
    ctx: ActionContext,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(values)) {
      const payloadMatch = typeof raw === 'string' ? raw.match(PAYLOAD_VALUE_TOKEN_RE) : null;
      const linkedMatch = typeof raw === 'string' ? raw.match(LINKED_VALUE_TOKEN_RE) : null;
      if (raw === '@me') out[key] = ctx.actorId;
      else if (raw === '@now') out[key] = new Date().toISOString();
      else if (raw === '@today') out[key] = new Date().toISOString().slice(0, 10);
      // #246: {index} as an entire value resolves to the batch item's number.
      else if (raw === '{index}' && ctx.itemIndex !== undefined) out[key] = ctx.itemIndex;
      // MN-254: a value that's *entirely* one {payload.…} token resolves to the
      // underlying typed value (number, object, …), not a stringified one — this
      // is a field VALUE, not text being templated.
      else if (payloadMatch) out[key] = getJsonPath(ctx.payload ?? {}, payloadMatch[1]!) ?? null;
      // #244: same idea for {linked.Field} — set a field straight from the just-
      // linked record's typed value (the "Start Date = linked Task's Due Date" case).
      else if (linkedMatch) out[key] = this.linkedFieldValue(ctx, linkedMatch[1]!) ?? null;
      else out[key] = raw;
    }
    return out;
  }

  /**
   * #244: resolve one field off the primary linked record (`ctx.linkedRecords[0]`),
   * mapping a display name via the linked database's own map. `title`/the name
   * field resolve to the record's title. Returns undefined when there is no
   * linked record (non-relation trigger) or the field is unknown.
   */
  private linkedFieldValue(ctx: ActionContext, rawKey: string): unknown {
    const linked = ctx.linkedRecords?.[0];
    if (!linked) return undefined;
    const key = rawKey.trim();
    const apiName = ctx.linkedDisplayToApi?.get(key) ?? key;
    if (apiName === 'name' || key.toLowerCase() === 'title') return linked.title;
    return linked.values[apiName];
  }

  /**
   * `escape` lets a caller make each substituted value safe for its surrounding
   * syntax — MN-088's JSON bodies need it, plain comment text does not.
   *
   * The token class excludes `{` as well as `}`: with `[^}]+` the regex ran
   * straight across a JSON template's own braces, so `{"task":"{Name}"}` matched
   * `{"task":"{Name}` as one token and mangled the body (MN-088).
   */
  /**
   * #339 — template tokens in EVERY string field of an action's `values`, not
   * only `name`.
   *
   * `create_record` interpolated `values.name` and nothing else, so a field
   * asking for `{changesSummary}` stored those eight literal characters — and
   * the run still reported `status: ok`, so the only way to notice was to open
   * the created record. Every other templated action (add_comment, notify,
   * email, webhook) already interpolated, which is what made the gap read as
   * "templating works" until you looked at the field you cared about.
   *
   * Only STRING values are touched: a select's option id, a number, a relation's
   * id array must pass through untouched, and none of them can carry a token.
   */
  private interpolateValues(
    values: Record<string, unknown>,
    ctx: ActionContext,
    displayToApi: Map<string, string>,
    /**
     * #342 — api_names of NUMBER fields on the TARGET database. Their templates
     * are evaluated as formulas rather than substituted as text, so
     * "{Remaining} - 1" computes instead of producing the string "4 - 1".
     */
    numeric?: { fields: ReadonlySet<string>; infos: FormulaFieldInfo[] },
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(values)) {
      if (typeof value !== 'string') {
        out[key] = value;
        continue;
      }
      if (numeric?.fields.has(key)) {
        out[key] = this.evaluateNumeric(value, ctx, key, numeric.infos);
        continue;
      }
      out[key] = this.interpolate(value, ctx, displayToApi);
    }
    return out;
  }

  /**
   * #342 — a number field's templated value, computed.
   *
   * Automations could set a number to a constant or copy another field
   * verbatim, but never COMPUTE one: "{Remaining} - 1" was substituted to the
   * text "4 - 1" and the write failed validation. So a counter, a countdown,
   * "add 1 to Times Contacted" — the most ordinary rules there are — could not
   * be written at all.
   *
   * Reuses the formula engine rather than inventing a second expression
   * language: same parser, same operators, same empty-propagation rules the
   * user already knows from formula fields.
   *
   * Only NUMBER targets take this path. A text field keeps literal
   * substitution, so "{Name} - 1" still writes what it always wrote.
   */
  /**
   * #342 — the number fields of a target database, plus the formula-field info
   * needed to resolve `{Display Name}` inside an expression.
   *
   * The INFOS come from the SOURCE database (the triggering record is what an
   * expression reads), while the number-field set comes from the TARGET — for a
   * create_record those are different databases, and conflating them would
   * either miss the target's number fields or resolve names against the wrong
   * schema.
   */
  private async numericContext(
    sourceDatabaseId: string,
    targetDatabaseId: string,
  ): Promise<{ fields: ReadonlySet<string>; infos: FormulaFieldInfo[] }> {
    const [targetFields, sourceFields] = await Promise.all([
      this.db.query.fields.findMany({
        where: and(eq(fields.databaseId, targetDatabaseId), isNull(fields.deletedAt)),
      }),
      sourceDatabaseId === targetDatabaseId
        ? Promise.resolve(null)
        : this.db.query.fields.findMany({
            where: and(eq(fields.databaseId, sourceDatabaseId), isNull(fields.deletedAt)),
          }),
    ]);
    const source = sourceFields ?? targetFields;
    const infos: FormulaFieldInfo[] = [];
    for (const f of source) {
      const formulaType = FieldsService.formulaTypeOf(f.type);
      if (formulaType) infos.push({ api_name: f.apiName, display_name: f.displayName, formula_type: formulaType });
    }
    return {
      fields: new Set(targetFields.filter((f) => f.type === 'number').map((f) => f.apiName)),
      infos,
    };
  }

  private evaluateNumeric(
    template: string,
    ctx: ActionContext,
    fieldApiName: string,
    infos: FormulaFieldInfo[],
  ): number | null {
    if (!template.trim()) return null;
    try {
      const ast = parseFormula(template, infos);
      const bag: Record<string, unknown> = { ...(ctx.record?.values ?? {}) };
      if (ctx.record) {
        bag['name'] = ctx.record.title;
        bag['number'] = ctx.record.number ?? null;
        bag['id'] = ctx.record.number ?? null;
      }
      const result = evaluateFormula(ast, bag);
      return typeof result === 'number' && Number.isFinite(result) ? result : null;
    } catch (error) {
      // Naming the field matters: the run log otherwise says only "validation
      // failed", and the author has to guess which of several values was wrong.
      throw new Error(
        `"${fieldApiName}" expects a number and its value could not be computed: ${(error as Error).message}`,
        { cause: error },
      );
    }
  }

  private interpolate(
    template: string,
    ctx: ActionContext,
    displayToApi: Map<string, string>,
    escape: (value: string) => string = (v) => v,
  ): string {
    return template.replace(/\{([^{}]+)\}/g, (_, name: string) => {
      const trimmed = name.trim();
      // #246: {index} → the 1-based batch item number (create_records); a no-op
      // ("") outside a batch, so a stray {index} never renders an em dash.
      if (trimmed.toLowerCase() === 'index') return escape(ctx.itemIndex !== undefined ? String(ctx.itemIndex) : '');
      // #273: {changesSummary} → what actually changed on the triggering record.
      if (trimmed.toLowerCase() === 'changessummary') return escape(ctx.changesSummary ?? '');
      // MN-254: {payload.a.b.0} reads the inbound webhook body, independent of
      // any field on this database — it has no display-name/api-name mapping.
      if (trimmed.toLowerCase().startsWith('payload.')) {
        const value = getJsonPath(ctx.payload ?? {}, trimmed.slice('payload.'.length));
        if (value === undefined || value === null) return escape('—');
        if (Array.isArray(value)) return escape(value.map((v) => String(v)).join(', '));
        if (typeof value === 'object') return escape(JSON.stringify(value));
        return escape(String(value));
      }
      // #244: {linked.Field} templates the just-linked record's value into text
      // (e.g. an add_comment body), the same way {Field} does for the host record.
      if (trimmed.toLowerCase().startsWith('linked.')) {
        if (!ctx.linkedRecords?.length) return escape('—');
        const value = this.linkedFieldValue(ctx, trimmed.slice('linked.'.length));
        if (value === undefined || value === null) return escape('—');
        if (Array.isArray(value))
          return escape(
            value
              .map((v) => (typeof v === 'object' && v ? ((v as { title?: string }).title ?? '') : String(v)))
              .join(', '),
          );
        return escape(String(value));
      }
      const apiName = displayToApi.get(trimmed) ?? trimmed;
      if (apiName === 'name' || trimmed.toLowerCase() === 'title') {
        return escape(ctx.record ? ctx.record.title : '—');
      }
      if (!ctx.record) return escape('—');
      /*
       * #339: the system columns. `number`/`id`/`created_at`/`updated_at` live on
       * the record ROW, not in its `values` bag, so reading `values[apiName]`
       * returned undefined and rendered an em dash — for `{Number}`, the most
       * natural way to reference a ticket. Same class of gap rollupFieldValue
       * had to close for #286 and systemFieldDefsFor for #351.
       */
      const lowerApi = apiName.toLowerCase();
      if (lowerApi === 'number' || lowerApi === 'id') {
        return escape(ctx.record.number === null || ctx.record.number === undefined ? '—' : String(ctx.record.number));
      }
      const value = ctx.record.values[apiName];
      if (value === undefined || value === null) return escape('—');
      if (Array.isArray(value))
        return escape(
          value
            .map((v) =>
              typeof v === 'object' && v ? ((v as { title?: string }).title ?? '') : String(v),
            )
            .join(', '),
        );
      return escape(String(value));
    });
  }

  /**
   * MN-255: fully render a `require_approval` action's tokens NOW — before it
   * ever reaches a human — so the frozen snapshot ApprovalsService stores is
   * exactly what runs on approve(), independent of any edit to the record
   * (or the payload it references) between now and then. Mirrors each
   * branch's own token-resolution below, just without the side effect.
   */
  private renderForApproval(
    action: AutomationAction,
    ctx: ActionContext,
    displayToApi: Map<string, string>,
  ): { snapshot: AutomationAction; previewText: string } {
    switch (action.type) {
      case 'set_values': {
        // #339: same as create_record — every string value, not just `name`.
        const values = this.interpolateValues(this.resolveTokens(action.values, ctx), ctx, displayToApi);
        return {
          snapshot: { ...action, values },
          previewText: `Set ${Object.keys(values).join(', ') || 'no fields'} on "${ctx.record?.title ?? 'this record'}"`,
        };
      }
      case 'create_record': {
        const values = this.interpolateValues(this.resolveTokens(action.values, ctx), ctx, displayToApi);
        return {
          snapshot: { ...action, values },
          previewText: `Create a record${typeof values.name === 'string' ? ` "${values.name}"` : ''}`,
        };
      }
      case 'create_records': {
        // #246: the per-item {index}/token resolution happens at execute() time
        // (one snapshot can't stand in for N records), so the frozen snapshot is
        // the action verbatim — the preview just states the batch intent.
        const count = this.resolveBatchCount(action.count, ctx, displayToApi);
        return { snapshot: action, previewText: `Create ${count} record${count === 1 ? '' : 's'}` };
      }
      case 'add_comment': {
        const text = this.interpolate(action.body_template, ctx, displayToApi);
        return { snapshot: { ...action, body_template: text }, previewText: `Comment: ${text.slice(0, 200)}` };
      }
      case 'notify_user': {
        const message = this.interpolate(action.message, ctx, displayToApi);
        return { snapshot: { ...action, message }, previewText: `Notify: ${message.slice(0, 200)}` };
      }
      case 'update_linked': {
        const values = this.resolveTokens(action.values, ctx);
        return {
          snapshot: { ...action, values },
          previewText: `Update linked records: ${Object.keys(values).join(', ') || 'no fields'}`,
        };
      }
      case 'send_slack_message': {
        const text = this.interpolate(action.text, ctx, displayToApi);
        return {
          snapshot: { ...action, text },
          previewText: `Slack message${action.channel ? ` to ${action.channel}` : ''}: ${text.slice(0, 200)}`,
        };
      }
      case 'send_webhook': {
        const url = this.interpolate(action.url, ctx, displayToApi, encodeURIComponent);
        const body_template = action.body_template
          ? this.interpolate(action.body_template, ctx, displayToApi, jsonEscape)
          : action.body_template;
        return { snapshot: { ...action, url, body_template }, previewText: `Webhook → ${url}` };
      }
      case 'run_agent': {
        // MN-109: no {Field} interpolation on `prompt` yet (Phase A keeps it
        // a static override) and no DB lookup here for the agent's display
        // name — same best-effort shape create_record's preview uses when it
        // has no record to read a title off of — so the snapshot is the
        // action verbatim and the preview shows the raw agent reference.
        return {
          snapshot: action,
          previewText: `Run agent ${action.agent}${action.prompt ? `: ${action.prompt.slice(0, 200)}` : ''}`,
        };
      }
      case 'send_email': {
        // MN-256: rendered HERE (once) whether or not this action ends up
        // gated — see execute()'s queued-job branch, which renders through
        // this same method for a non-gated send_email so the executor never
        // touches {Field}/{payload} interpolation itself, only strings.
        const to = this.interpolate(action.to, ctx, displayToApi);
        const cc = action.cc ? this.interpolate(action.cc, ctx, displayToApi) : action.cc;
        const reply_to = action.reply_to ? this.interpolate(action.reply_to, ctx, displayToApi) : action.reply_to;
        const subject = this.interpolate(action.subject, ctx, displayToApi);
        const body_markdown = this.interpolate(action.body_markdown, ctx, displayToApi);
        return {
          snapshot: { ...action, to, cc, reply_to, subject, body_markdown },
          previewText: `Email ${to}: ${subject}`,
        };
      }
      case 'http_request': {
        const snapshot = { ...action, ...this.renderHttpRequestTemplates(action, ctx, displayToApi) };
        return { snapshot, previewText: `${action.method} ${snapshot.url}` };
      }
    }
  }

  /**
   * MN-263 — the editor's "send test request": renders a single http_request
   * action's templates against a real record, for AutomationsService.test()'s
   * execute-just-this-action mode. A no-op passthrough for any other action
   * type (test-request only exists for http_request today).
   */
  async renderForTest(databaseId: string, action: AutomationAction, ctx: ActionContext): Promise<AutomationAction> {
    if (action.type !== 'http_request') return action;
    const live = await this.db.query.fields.findMany({
      where: and(eq(fields.databaseId, databaseId), isNull(fields.deletedAt)),
    });
    const displayToApi = new Map(live.map((f) => [f.displayName, f.apiName]));
    return { ...action, ...this.renderHttpRequestTemplates(action, ctx, displayToApi) };
  }

  /**
   * MN-263 — renders an http_request action's templated url/headers/
   * body_template NOW, against the record/payload available at this instant.
   * Shared by renderForApproval() (MN-255's frozen snapshot) and execute()'s
   * durable-job path below — a queued job's payload carries only ctx.recordId,
   * not the record's field values, so rendering has to happen here, before
   * the job is enqueued, not inside the executor.
   */
  private renderHttpRequestTemplates(
    action: Extract<AutomationAction, { type: 'http_request' }>,
    ctx: ActionContext,
    displayToApi: Map<string, string>,
  ): { url: string; headers?: Record<string, string>; body_template?: string } {
    const url = this.interpolate(action.url, ctx, displayToApi, encodeURIComponent);
    const headers = action.headers
      ? Object.fromEntries(
          Object.entries(action.headers).map(([name, value]) => [name, this.interpolate(value, ctx, displayToApi)]),
        )
      : undefined;
    const body_template = action.body_template
      ? this.interpolate(action.body_template, ctx, displayToApi, jsonEscape)
      : action.body_template;
    return { url, headers, body_template };
  }

  /**
   * #245 — does a per-action `condition` hold for the triggering record? Same
   * evaluation as a rule's own condition (AutomationsService.conditionMatches):
   * compile the filter AST and re-select the trigger record with it applied. No
   * record in context (webhook_received) → nothing to test, so the action runs.
   */
  private async actionConditionPasses(ctx: ActionContext, condition: unknown): Promise<boolean> {
    if (!ctx.record) return true;
    const defs = await this.recordsService.fieldDefs(ctx.databaseId);
    const where = compileFilter(condition as FilterNode, {
      defs: new Map(defs.map((d) => [d.api_name, d])),
      currentUserId: ctx.actorId,
    });
    const [row] = await this.db
      .select({ id: records.id })
      .from(records)
      .where(and(eq(records.id, ctx.record.id), where))
      .limit(1);
    return Boolean(row);
  }

  /**
   * #246 — resolve a create_records `count`: a literal number, or a `{Field}`/
   * `{payload.…}` token string rendered against the trigger record and parsed to
   * an int. Clamped to [0, MAX_BATCH_CREATE]; anything unparseable/negative → 0
   * (a safe no-op rather than a crash).
   */
  private resolveBatchCount(count: number | string, ctx: ActionContext, displayToApi: Map<string, string>): number {
    const n = typeof count === 'number' ? count : Number.parseInt(this.interpolate(count, ctx, displayToApi), 10);
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.min(Math.floor(n), MAX_BATCH_CREATE);
  }

  /**
   * Executes actions in order. Any failure throws — callers wrap a press in
   * one logical transaction by re-validating first; individual service calls
   * are already transactional, and a mid-list validation error aborts before
   * any write via the upfront re-validate.
   */
  async execute(actions: AutomationAction[], ctx: ActionContext): Promise<ActionEffect[]> {
    // Re-validate against the live schema so stale configs 422 instead of 500.
    await this.validate(ctx.databaseId, ctx.workspaceId, actions, ctx.triggerType);
    const live = await this.db.query.fields.findMany({
      where: and(eq(fields.databaseId, ctx.databaseId), isNull(fields.deletedAt)),
    });
    const displayToApi = new Map(live.map((f) => [f.displayName, f.apiName]));

    // #244: the linked record (record_linked trigger) is in another database, so
    // resolve THAT database's display→api map once so `{linked.Status}` works.
    if (ctx.linkedDatabaseId && !ctx.linkedDisplayToApi) {
      const linkedFields = await this.db.query.fields.findMany({
        where: and(eq(fields.databaseId, ctx.linkedDatabaseId), isNull(fields.deletedAt)),
      });
      ctx.linkedDisplayToApi = new Map(linkedFields.map((f) => [f.displayName, f.apiName]));
    }

    const effects: ActionEffect[] = [];
    for (const [actionIndex, action] of actions.entries()) {
      // #245: an optional per-action condition gates JUST this action. A
      // non-match skips it (reported as skipped, not failed) and later actions
      // still run — so a side-effecting action (http_request, send_email) can be
      // fired only when a check passes, no outbound call otherwise.
      if (action.condition !== undefined && action.condition !== null) {
        if (!(await this.actionConditionPasses(ctx, action.condition))) {
          effects.push({ type: 'skipped', summary: `Skipped ${action.type}: condition not met` });
          continue;
        }
      }
      // MN-256: send_email defaults to gated UNLESS every rendered recipient
      // resolves to a workspace member's email — that can only be known at
      // RUN time (the addresses come from {Field}/{payload} tokens), unlike
      // every other action's require_approval, which is exactly what was
      // saved. An explicit `true`/`false` on the action always wins outright:
      // this defaulting only ever applies when the field was left unset.
      let requireApproval = action.require_approval;
      if (action.type === 'send_email' && requireApproval === undefined) {
        requireApproval = true;
        const addresses = splitEmailAddresses(
          [this.interpolate(action.to, ctx, displayToApi), action.cc ? this.interpolate(action.cc, ctx, displayToApi) : '']
            .filter(Boolean)
            .join(','),
        );
        if (addresses.length > 0 && (await this.allRecipientsInternal(ctx.workspaceId, addresses))) {
          requireApproval = false;
        }
      }
      // MN-255: a gated action stops here — render its tokens now (so the
      // frozen snapshot can't drift from a later record edit), insert an
      // approval + notify its approver, and do NOT enqueue an MN-253 job or
      // run inline. ApprovalsService.approve() enqueues the job later, from
      // the SAME snapshot rendered here.
      if (requireApproval) {
        const { snapshot, previewText } = this.renderForApproval(action, ctx, displayToApi);
        const effect = await this.approvals.create({
          workspaceId: ctx.workspaceId,
          databaseId: ctx.databaseId,
          ruleId: ctx.ruleId ?? null,
          runId: ctx.runId ?? null,
          recordId: ctx.record?.id ?? null,
          actionIndex,
          action: snapshot,
          previewText,
          requesterActorId: ctx.actorId,
        });
        effects.push(effect);
        continue;
      }
      // MN-253: an action kind with a registered executor (run_agent;
      // send_email as of MN-256; http_request as of MN-263; post_social.*/
      // youtube_upload to follow, MN-257/258/259) never runs inline — it's
      // durable-queued instead, so a flaky provider retries with backoff
      // rather than stalling this record's save or double-firing on a retry.
      if (this.jobs.hasExecutor(action.type)) {
        const runId = ctx.runId ?? 'no-run';
        const idempotencyKey = buildIdempotencyKey({
          ruleId: ctx.ruleId ?? null,
          recordId: ctx.record?.id ?? null,
          runId,
          actionIndex,
        });
        // Forward-compatible: no current action carries a connection id, but
        // a future external-kind schema will — extracted opportunistically so
        // the circuit breaker/rate limiter (job-runner.service.ts) has it.
        const connectionId =
          typeof (action as Record<string, unknown>).connection_id === 'string'
            ? ((action as Record<string, unknown>).connection_id as string)
            : null;
        // MN-256/263: render {Field}/{payload} tokens NOW, before the job is
        // enqueued — the same reasoning renderForApproval's own doc comment
        // gives for the gated path — so the executor (job-runner.service.ts's
        // registered fn) only ever handles already-resolved strings and never
        // duplicates this service's own interpolation logic (the job payload
        // below carries only ctx.recordId, not the record's field values a
        // later re-render would need). Harmless no-op for every other
        // registered kind today (run_agent's own case returns the action
        // verbatim).
        const enqueueAction: AutomationAction =
          action.type === 'send_email'
            ? this.renderForApproval(action, ctx, displayToApi).snapshot
            : action.type === 'http_request'
              ? { ...action, ...this.renderHttpRequestTemplates(action, ctx, displayToApi) }
              : action;
        const { jobId } = await this.jobs.enqueue({
          workspaceId: ctx.workspaceId,
          ruleId: ctx.ruleId ?? null,
          runId: ctx.runId ?? null,
          connectionId,
          actionIndex,
          kind: action.type,
          payload: {
            action: enqueueAction,
            ctx: {
              workspaceId: ctx.workspaceId,
              databaseId: ctx.databaseId,
              recordId: ctx.record?.id ?? null,
              actorId: ctx.actorId,
              // MN-109: carried so a run_agent executor's own record writes
              // (via AgentsService.dispatchRun's applyProposedAction) inherit
              // THIS call's depth rather than resetting to 0 across the queue
              // boundary — without it, an agent write-back that re-triggers
              // the same rule would never hit automations.service.ts's
              // MAX_DEPTH loop guard. Harmless for every other registered
              // kind today (none write back to records).
              depth: ctx.depth ?? 0,
            },
          },
          idempotencyKey,
        });
        effects.push({
          type: 'queued_job',
          record_id: ctx.record?.id,
          summary: `Queued ${action.type} (job ${jobId})`,
        });
        continue;
      }
      if (action.type === 'set_values') {
        // validate() already refused this action on a record-less (webhook)
        // context — ctx.record is guaranteed here.
        const record = ctx.record!;
        // #339: every string value. #342: number targets are COMPUTED.
        const values = this.interpolateValues(
          this.resolveTokens(action.values, ctx),
          ctx,
          displayToApi,
          await this.numericContext(ctx.databaseId, ctx.databaseId),
        );
        await this.recordsService.update(
          ctx.workspaceId,
          ctx.databaseId,
          record.id,
          values,
          ctx.actorId,
          ctx.depth ?? 0,
        );
        effects.push({
          type: 'set_values',
          record_id: record.id,
          summary: `Set ${Object.keys(values).join(', ')}`,
        });
      } else if (action.type === 'create_record') {
        // #339: EVERY string value. This is the path that actually runs — the
        // preview/snapshot branch above is a separate call site, and patching
        // only one of them would have made the preview honest and the write
        // still literal. #342: number targets are COMPUTED, not substituted.
        const values = this.interpolateValues(
          this.resolveTokens(action.values, ctx),
          ctx,
          displayToApi,
          await this.numericContext(ctx.databaseId, action.database_id),
        );
        const created = await this.recordsService.create(
          ctx.workspaceId,
          action.database_id,
          values,
          ctx.actorId,
          ctx.depth ?? 0,
        );
        // MN-254: a webhook-triggered create_record has no source record to link
        // back to — skip the link rather than crash.
        if (action.link_via_relation_field_id && ctx.record) {
          await this.relationsService.addLinks(
            ctx.workspaceId,
            action.database_id,
            created.id,
            action.link_via_relation_field_id,
            [ctx.record.id],
            ctx.actorId,
          );
        }
        effects.push({
          type: 'create_record',
          record_id: created.id,
          summary: `Created "${created.title}"`,
        });
      } else if (action.type === 'create_records') {
        // #246: a dynamic-count batch create. Each record shares one template;
        // {index} (1-based) differentiates them. Sidesteps the loop guard — the
        // rule fires once and this action fans out N records in-line.
        const count = this.resolveBatchCount(action.count, ctx, displayToApi);
        let createdCount = 0;
        for (let i = 0; i < count; i++) {
          const itemCtx: ActionContext = { ...ctx, itemIndex: i + 1 };
          // #339: every string value, per item — so {index} and {changesSummary}
          // reach the batch's other fields, not only its name.
          const values = this.interpolateValues(this.resolveTokens(action.values, itemCtx), itemCtx, displayToApi);
          const created = await this.recordsService.create(
            ctx.workspaceId,
            action.database_id,
            values,
            ctx.actorId,
            ctx.depth ?? 0,
          );
          createdCount += 1;
          if (action.link_via_relation_field_id && ctx.record) {
            await this.relationsService.addLinks(
              ctx.workspaceId,
              action.database_id,
              created.id,
              action.link_via_relation_field_id,
              [ctx.record.id],
              ctx.actorId,
            );
          }
        }
        effects.push({
          type: 'create_records',
          summary: `Created ${createdCount} record${createdCount === 1 ? '' : 's'}`,
        });
      } else if (action.type === 'add_comment') {
        // validate() already refused this action on a record-less (webhook)
        // context — ctx.record is guaranteed here.
        const record = ctx.record!;
        const text = this.interpolate(action.body_template, ctx, displayToApi);
        await this.commentsService.create(
          ctx.workspaceId,
          record.id,
          [{ type: 'text', text }],
          ctx.actorId,
        );
        effects.push({ type: 'add_comment', record_id: record.id, summary: 'Commented' });
      } else if (action.type === 'notify_user') {
        const message = this.interpolate(action.message, ctx, displayToApi);
        let recipients: string[];
        if (action.user === '@me') recipients = [ctx.actorId];
        else if (ctx.record) {
          const raw = ctx.record.values[action.user];
          recipients = Array.isArray(raw) ? (raw as string[]) : raw ? [String(raw)] : [];
        } else {
          // validate() only allows a non-'@me' user field when a record exists.
          recipients = [];
        }
        await this.notificationsService.notify({
          workspaceId: ctx.workspaceId,
          databaseId: ctx.databaseId,
          recordId: ctx.record?.id,
          actorId: ctx.actorId,
          type: 'mentioned',
          recipients,
          snippet: message,
        });
        effects.push({
          type: 'notify_user',
          record_id: ctx.record?.id,
          summary: `Notified ${recipients.length} user(s)`,
        });
      } else if (action.type === 'update_linked') {
        // validate() already refused this action on a record-less (webhook)
        // context — ctx.record is guaranteed here.
        const resolved = await this.resolveLinked(
          ctx.databaseId,
          action.relation_field_id,
          ctx.record!,
        );
        if (resolved && resolved.linkedIds.length > 0) {
          const values = this.resolveTokens(action.values, ctx);
          for (const linkedId of resolved.linkedIds) {
            await this.recordsService.update(
              ctx.workspaceId,
              resolved.targetDbId,
              linkedId,
              values,
              ctx.actorId,
              ctx.depth ?? 0,
            );
          }
          effects.push({
            type: 'update_linked',
            summary: `Updated ${resolved.linkedIds.length} linked record(s)`,
          });
        } else {
          effects.push({ type: 'update_linked', summary: 'No linked records to update' });
        }
      } else if (action.type === 'send_webhook') {
        // MN-088: queue through the shared outbox first, so a failure is retried by
        // MN-032's backoff rather than lost — then send once now to report a real
        // status code back to the presser.
        const url = this.interpolate(action.url, ctx, displayToApi, encodeURIComponent);
        const payload = action.body_template
          ? // A template is usually JSON; parse it so the receiver gets an object
            // rather than a double-encoded string. Non-JSON is sent as {body}.
            // Values are JSON-escaped as they go in, so a title containing a quote
            // can't break out of the string it lands in.
            parseTemplateBody(this.interpolate(action.body_template, ctx, displayToApi, jsonEscape))
          : {
              event: 'button.pressed',
              occurred_at: new Date().toISOString(),
              actor_id: ctx.actorId,
              workspace: { id: ctx.workspaceId },
              // MN-254: a webhook-triggered rule has no record — send the
              // delivered payload back out instead, so the receiver still gets
              // something to act on.
              record: ctx.record
                ? { id: ctx.record.id, title: ctx.record.title, values: ctx.record.values }
                : null,
              payload: ctx.record ? undefined : (ctx.payload ?? null),
            };
        try {
          const delivery = await this.webhooksService.enqueueDirect({
            workspaceId: ctx.workspaceId,
            url,
            eventType: 'button.pressed',
            payload,
          });
          // Persisted actions only ever hold string header values; coerce for the
          // sender's string-map type (the header union is a read/write-shape concern).
          const result = await this.webhooksService.sendNow(
            delivery.id,
            stringHeadersOnly(action.headers),
          );
          effects.push({
            type: 'send_webhook',
            record_id: ctx.record?.id,
            summary: result.ok
              ? `Webhook delivered (HTTP ${result.statusCode})`
              : `Webhook failed (${result.error ?? 'unknown error'}) — will retry`,
          });
        } catch (err) {
          effects.push({
            type: 'send_webhook',
            record_id: ctx.record?.id,
            summary: `Webhook failed: ${err instanceof Error ? err.message : 'unknown error'}`,
          });
        }
      } else if (action.type === 'send_slack_message') {
        const text = this.interpolate(action.text, ctx, displayToApi);
        // External side-effect: don't let an unconfigured Slack or a network
        // blip roll back the triggering record write — record it and move on.
        try {
          const sent = await this.slackService.sendMessage(ctx.workspaceId, {
            channel: action.channel,
            text,
          });
          effects.push({
            type: 'send_slack_message',
            record_id: ctx.record?.id,
            summary: `Sent Slack message${sent.channel ? ` to ${sent.channel}` : ''}`,
          });
        } catch (err) {
          effects.push({
            type: 'send_slack_message',
            record_id: ctx.record?.id,
            summary: `Slack message failed: ${err instanceof Error ? err.message : 'unknown error'}`,
          });
        }
      }
    }
    return effects;
  }
}
