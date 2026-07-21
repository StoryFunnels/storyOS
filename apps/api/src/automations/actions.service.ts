import { Inject, Injectable, UnprocessableEntityException } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import type { AutomationAction } from '@storyos/schemas';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { databases, fields, relations } from '../db/schema';
import { CommentsService } from '../comments/comments.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { SlackService } from '../integrations/slack.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RecordsService } from '../records/records.service';
import type { ProjectedRecord } from '../records/records.service';
import { RelationsService } from '../relations/relations.service';
import { stringHeadersOnly } from '../common/webhook-headers';
import { getJsonPath } from '../common/json-path';

/** Full token match — `{payload.a.b.0}`, nothing else in the string. */
const PAYLOAD_VALUE_TOKEN_RE = /^\{payload\.([^{}]+)\}$/;

/**
 * MN-254: the only actions that don't require a triggering record — safe to
 * run from a webhook_received rule. Everything else (set_values, add_comment,
 * update_linked) exists to write back to the record that fired the rule, and
 * a webhook delivery has none.
 */
const WEBHOOK_SAFE_ACTIONS = new Set([
  'create_record',
  'send_slack_message',
  'send_webhook',
  'notify_user',
]);

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
}

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
  ) {}

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
   * to write back to one.
   */
  async validate(
    databaseId: string,
    workspaceId: string,
    actions: AutomationAction[],
    triggerType?: string,
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
      if (action.type === 'create_record') {
        const target = await this.db.query.databases.findFirst({
          where: and(eq(databases.id, action.database_id), eq(databases.workspaceId, workspaceId)),
        });
        if (!target)
          throw new UnprocessableEntityException('create_record targets an unknown database');
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
    }
  }

  private resolveTokens(
    values: Record<string, unknown>,
    ctx: ActionContext,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(values)) {
      const payloadMatch = typeof raw === 'string' ? raw.match(PAYLOAD_VALUE_TOKEN_RE) : null;
      if (raw === '@me') out[key] = ctx.actorId;
      else if (raw === '@now') out[key] = new Date().toISOString();
      else if (raw === '@today') out[key] = new Date().toISOString().slice(0, 10);
      // MN-254: a value that's *entirely* one {payload.…} token resolves to the
      // underlying typed value (number, object, …), not a stringified one — this
      // is a field VALUE, not text being templated.
      else if (payloadMatch) out[key] = getJsonPath(ctx.payload ?? {}, payloadMatch[1]!) ?? null;
      else out[key] = raw;
    }
    return out;
  }

  /**
   * `escape` lets a caller make each substituted value safe for its surrounding
   * syntax — MN-088's JSON bodies need it, plain comment text does not.
   *
   * The token class excludes `{` as well as `}`: with `[^}]+` the regex ran
   * straight across a JSON template's own braces, so `{"task":"{Name}"}` matched
   * `{"task":"{Name}` as one token and mangled the body (MN-088).
   */
  private interpolate(
    template: string,
    ctx: ActionContext,
    displayToApi: Map<string, string>,
    escape: (value: string) => string = (v) => v,
  ): string {
    return template.replace(/\{([^{}]+)\}/g, (_, name: string) => {
      const trimmed = name.trim();
      // MN-254: {payload.a.b.0} reads the inbound webhook body, independent of
      // any field on this database — it has no display-name/api-name mapping.
      if (trimmed.toLowerCase().startsWith('payload.')) {
        const value = getJsonPath(ctx.payload ?? {}, trimmed.slice('payload.'.length));
        if (value === undefined || value === null) return escape('—');
        if (Array.isArray(value)) return escape(value.map((v) => String(v)).join(', '));
        if (typeof value === 'object') return escape(JSON.stringify(value));
        return escape(String(value));
      }
      const apiName = displayToApi.get(trimmed) ?? trimmed;
      if (apiName === 'name' || trimmed.toLowerCase() === 'title') {
        return escape(ctx.record ? ctx.record.title : '—');
      }
      if (!ctx.record) return escape('—');
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

    const effects: ActionEffect[] = [];
    for (const action of actions) {
      if (action.type === 'set_values') {
        // validate() already refused this action on a record-less (webhook)
        // context — ctx.record is guaranteed here.
        const record = ctx.record!;
        const values = this.resolveTokens(action.values, ctx);
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
        const values = this.resolveTokens(action.values, ctx);
        if (typeof values.name === 'string') {
          values.name = this.interpolate(values.name, ctx, displayToApi);
        }
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
