import { Inject, Injectable, UnprocessableEntityException } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import type { AutomationAction } from '@storyos/schemas';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { databases, fields } from '../db/schema';
import { CommentsService } from '../comments/comments.service';
import { RecordsService } from '../records/records.service';
import type { ProjectedRecord } from '../records/records.service';
import { RelationsService } from '../relations/relations.service';

export interface ActionContext {
  workspaceId: string;
  databaseId: string;
  record: ProjectedRecord;
  actorId: string;
  /** Loop-guard depth for automation-caused writes (MN-047). */
  depth?: number;
}

export interface ActionEffect {
  type: string;
  record_id?: string;
  summary: string;
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
  ) {}

  /** Save-time validation: every reference must exist right now. */
  async validate(databaseId: string, workspaceId: string, actions: AutomationAction[]): Promise<void> {
    const live = await this.db.query.fields.findMany({
      where: and(eq(fields.databaseId, databaseId), isNull(fields.deletedAt)),
    });
    const apiNames = new Set(live.map((f) => f.apiName));
    for (const action of actions) {
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
        if (!target) throw new UnprocessableEntityException('create_record targets an unknown database');
        if (action.link_via_relation_field_id) {
          const relField = await this.db.query.fields.findFirst({
            where: and(
              eq(fields.id, action.link_via_relation_field_id),
              eq(fields.databaseId, action.database_id),
              isNull(fields.deletedAt),
            ),
          });
          if (!relField || relField.type !== 'relation') {
            throw new UnprocessableEntityException('link_via_relation_field_id must be a relation field on the target database');
          }
        }
      }
    }
  }

  private resolveTokens(values: Record<string, unknown>, ctx: ActionContext): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(values)) {
      if (raw === '@me') out[key] = ctx.actorId;
      else if (raw === '@now') out[key] = new Date().toISOString();
      else if (raw === '@today') out[key] = new Date().toISOString().slice(0, 10);
      else out[key] = raw;
    }
    return out;
  }

  private interpolate(template: string, ctx: ActionContext, displayToApi: Map<string, string>): string {
    return template.replace(/\{([^}]+)\}/g, (_, name: string) => {
      const apiName = displayToApi.get(name.trim()) ?? name.trim();
      if (apiName === 'name' || name.trim().toLowerCase() === 'title') return ctx.record.title;
      const value = ctx.record.values[apiName];
      if (value === undefined || value === null) return '—';
      if (Array.isArray(value)) return value.map((v) => (typeof v === 'object' && v ? (v as { title?: string }).title ?? '' : String(v))).join(', ');
      return String(value);
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
    await this.validate(ctx.databaseId, ctx.workspaceId, actions);
    const live = await this.db.query.fields.findMany({
      where: and(eq(fields.databaseId, ctx.databaseId), isNull(fields.deletedAt)),
    });
    const displayToApi = new Map(live.map((f) => [f.displayName, f.apiName]));

    const effects: ActionEffect[] = [];
    for (const action of actions) {
      if (action.type === 'set_values') {
        const values = this.resolveTokens(action.values, ctx);
        await this.recordsService.update(ctx.workspaceId, ctx.databaseId, ctx.record.id, values, ctx.actorId, ctx.depth ?? 0);
        effects.push({ type: 'set_values', record_id: ctx.record.id, summary: `Set ${Object.keys(values).join(', ')}` });
      } else if (action.type === 'create_record') {
        const values = this.resolveTokens(action.values, ctx);
        if (typeof values.name === 'string') {
          values.name = this.interpolate(values.name, ctx, displayToApi);
        }
        const created = await this.recordsService.create(ctx.workspaceId, action.database_id, values, ctx.actorId, ctx.depth ?? 0);
        if (action.link_via_relation_field_id) {
          await this.relationsService.addLinks(
            ctx.workspaceId,
            action.database_id,
            created.id,
            action.link_via_relation_field_id,
            [ctx.record.id],
            ctx.actorId,
          );
        }
        effects.push({ type: 'create_record', record_id: created.id, summary: `Created "${created.title}"` });
      } else if (action.type === 'add_comment') {
        const text = this.interpolate(action.body_template, ctx, displayToApi);
        await this.commentsService.create(ctx.workspaceId, ctx.record.id, [{ type: 'text', text }], ctx.actorId);
        effects.push({ type: 'add_comment', record_id: ctx.record.id, summary: 'Commented' });
      }
    }
    return effects;
  }
}
