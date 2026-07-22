import {
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { BillingService } from '../billing/billing.service';
import { resolveDatabaseColor } from '../common/database-color';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { databases, fields, memberships, relations, selectOptions, user, views } from '../db/schema';
import { RecordsService } from '../records/records.service';

/** Field types a public form can render/accept (MN-101, MN-224: relation + user). */
const SUPPORTED = new Set([
  'title',
  'text',
  'rich_text',
  'number',
  'date',
  'checkbox',
  'url',
  'email',
  'select',
  'multi_select',
  'user',
  'relation',
]);

interface FormFieldCfg {
  field_id: string;
  required?: boolean;
  label?: string;
  help?: string;
}

/**
 * Public (unauthenticated) form definition + submission (MN-101). A form is
 * shareable when its view's `config.form.access` is `link` or `public`; the
 * token in the URL is the only credential. Members-only forms are never served
 * here — they stay behind the in-app authenticated view.
 */
@Injectable()
export class FormsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly records: RecordsService,
    private readonly billing: BillingService,
  ) {}

  /** Resolve a public token → its view + form config + database, or 404. */
  private async resolve(token: string) {
    const [view] = await this.db
      .select()
      .from(views)
      .where(sql`${views.config} -> 'form' ->> 'public_token' = ${token}`)
      .limit(1);
    if (!view) throw new NotFoundException('Form not found');
    const form = ((view.config as Record<string, unknown>).form ?? {}) as {
      access?: string;
      fields?: FormFieldCfg[];
      title?: string;
      description?: string;
      submit_text?: string;
      success_message?: string;
      redirect_url?: string;
    };
    if (form.access !== 'link' && form.access !== 'public') {
      throw new NotFoundException('Form not found'); // members-only is not public
    }
    const database = await this.db.query.databases.findFirst({
      where: eq(databases.id, view.databaseId),
    });
    if (!database) throw new NotFoundException('Form not found');
    return { view, form, database };
  }

  /** The renderable form definition — no workspace internals leak beyond the fields. */
  async getDefinition(token: string) {
    const { view, form, database } = await this.resolve(token);
    const fieldRows = await this.db.query.fields.findMany({
      where: and(eq(fields.databaseId, database.id), isNull(fields.deletedAt)),
      orderBy: [asc(fields.position)],
    });
    const byId = new Map(fieldRows.map((f) => [f.id, f]));

    const formFields = form.fields ?? [];
    const cfgById = new Map(formFields.map((f) => [f.field_id, f]));
    // Field order: the form's own list, else the view's card fields (back-compat
    // with forms saved before the drag-to-reorder sidebar builder shipped).
    const orderIds = formFields.length
      ? formFields.map((f) => f.field_id)
      : ((view.config as { card_field_ids?: string[] }).card_field_ids ?? []);

    let chosen = orderIds
      .map((id) => byId.get(id))
      .filter((f): f is (typeof fieldRows)[number] => Boolean(f) && SUPPORTED.has(f!.type));

    const selectIds = chosen
      .filter((f) => f.type === 'select' || f.type === 'multi_select')
      .map((f) => f.id);
    const options = selectIds.length
      ? await this.db.query.selectOptions.findMany({
          where: inArray(selectOptions.fieldId, selectIds),
          orderBy: [asc(selectOptions.position)],
        })
      : [];
    const optsByField = new Map<string, { id: string; label: string }[]>();
    for (const o of options) {
      const list = optsByField.get(o.fieldId) ?? [];
      list.push({ id: o.id, label: o.label });
      optsByField.set(o.fieldId, list);
    }

    // Relation fields (MN-224): resolve each field's target database so the
    // public form can render a record picker for it. A relation whose config no
    // longer resolves (e.g. the relation was deleted) is dropped from the form
    // rather than rendered broken.
    const relationFields = chosen.filter((f) => f.type === 'relation');
    const relationIds = [
      ...new Set(
        relationFields
          .map((f) => (f.config as { relation_id?: string }).relation_id)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    const relationRows = relationIds.length
      ? await this.db.query.relations.findMany({ where: inArray(relations.id, relationIds) })
      : [];
    const relationById = new Map(relationRows.map((r) => [r.id, r]));
    const relationInfoByField = new Map<
      string,
      {
        target_database_id: string;
        target_database_name: string | null;
        target_database_color: string | null;
        single: boolean;
      }
    >();
    const targetDbIds = new Set<string>();
    for (const f of relationFields) {
      const cfg = f.config as { relation_id?: string; side?: 'a' | 'b' };
      const rel = cfg.relation_id ? relationById.get(cfg.relation_id) : undefined;
      if (!rel || !cfg.side) continue;
      const targetDatabaseId = cfg.side === 'a' ? rel.databaseBId : rel.databaseAId;
      targetDbIds.add(targetDatabaseId);
      // Mirrors the in-app RelationEditor's single-vs-multi rule (relation-cell.tsx).
      const single = rel.cardinality === 'one_to_many' && cfg.side === 'a';
      relationInfoByField.set(f.id, {
        target_database_id: targetDatabaseId,
        target_database_name: null,
        target_database_color: null,
        single,
      });
    }
    if (targetDbIds.size) {
      const targetDbRows = await this.db.query.databases.findMany({
        where: inArray(databases.id, [...targetDbIds]),
        columns: { id: true, name: true, color: true },
      });
      const nameById = new Map(targetDbRows.map((d) => [d.id, d.name]));
      // MN-299: resolved (never-null) so the form's relation search UI can
      // carry a marker color with no extra per-field fetch.
      const colorById = new Map(targetDbRows.map((d) => [d.id, resolveDatabaseColor(d.id, d.color)]));
      for (const [fieldId, info] of relationInfoByField) {
        relationInfoByField.set(fieldId, {
          ...info,
          target_database_name: nameById.get(info.target_database_id) ?? null,
          target_database_color: colorById.get(info.target_database_id) ?? null,
        });
      }
    }
    // A relation field we couldn't resolve is unusable — drop it (back-compat safety).
    chosen = chosen.filter((f) => f.type !== 'relation' || relationInfoByField.has(f.id));

    // User fields (MN-224): expose the active-member roster so the form can render
    // a people picker. Conservative — id + name only, no email/other PII.
    const hasUserField = chosen.some((f) => f.type === 'user');
    const workspaceMembers = hasUserField
      ? await this.db
          .select({ id: user.id, name: user.name })
          .from(memberships)
          .innerJoin(user, eq(user.id, memberships.userId))
          .where(and(eq(memberships.workspaceId, database.workspaceId), eq(memberships.status, 'active')))
      : [];

    // "Powered by StoryOS" attribution (#269) — the highest-value brand-exposure
    // surface is exactly the embedded case, so it's shown on both the standalone
    // link and the embed. Paid plans get the standard freemium-badge removal
    // (Typeform/Calendly/Substack pattern) via the same entitlements read path
    // MN-168 established (BillingService.getStatus), no new toggle needed.
    const billingStatus = await this.billing.getStatus(database.workspaceId);
    const hideBranding = billingStatus.plan !== 'free';

    return {
      title: form.title || database.name,
      description: form.description ?? null,
      submit_text: form.submit_text || 'Submit',
      success_message: form.success_message ?? null,
      redirect_url: form.redirect_url ?? null,
      hide_branding: hideBranding,
      fields: chosen.map((f) => ({
        field_id: f.id,
        api_name: f.apiName,
        type: f.type,
        label: cfgById.get(f.id)?.label || f.displayName,
        help: cfgById.get(f.id)?.help ?? null,
        required: cfgById.get(f.id)?.required ?? false,
        options: optsByField.get(f.id),
        relation: f.type === 'relation' ? relationInfoByField.get(f.id) : undefined,
        members: f.type === 'user' ? workspaceMembers : undefined,
        // Single- vs multi-pick (MN-224) — the public renderer must match this
        // exactly: the record write path rejects an array for a non-multi user
        // field (and vice versa), see coerce() in record-values.ts.
        multi: f.type === 'user' ? (f.config as { multi?: boolean }).multi === true : undefined,
      })),
    };
  }

  /**
   * Resolve a public form's own relation field → its target database, scoped
   * strictly by the token + the field being one the form actually exposes.
   * Backs the search/create-target endpoints (MN-224) — a public visitor can
   * only reach a target database the form owner already chose to expose.
   */
  private async resolveRelationField(token: string, fieldId: string) {
    const def = await this.getDefinition(token);
    const field = def.fields.find((f) => f.field_id === fieldId && f.type === 'relation' && f.relation);
    if (!field?.relation) throw new NotFoundException('Form field not found');
    return field.relation;
  }

  /** Candidate records for a public form's relation field (title search, MN-224). */
  async searchRelationCandidates(token: string, fieldId: string, q?: string) {
    const { target_database_id } = await this.resolveRelationField(token, fieldId);
    const page = await this.records.list(target_database_id, { limit: 20, q });
    return page.data.map((r) => ({ id: r.id, title: r.title, number: r.number }));
  }

  /** Inline "create new" for a public form's relation field — title only (MN-224). */
  async createRelationTarget(token: string, fieldId: string, title: string) {
    const { target_database_id } = await this.resolveRelationField(token, fieldId);
    const targetDatabase = await this.db.query.databases.findFirst({
      where: eq(databases.id, target_database_id),
    });
    if (!targetDatabase) throw new NotFoundException('Target database not found');
    // Anonymous author, title only — the same trust level as the main submit.
    const created = await this.records.create(
      targetDatabase.workspaceId,
      target_database_id,
      { name: title.slice(0, 500) },
      null,
    );
    return { id: created.id, title: created.title, number: created.number };
  }

  /** Validate + create a record from a public submission (anonymous author). */
  async submit(token: string, values: Record<string, unknown>, honeypot?: string) {
    // Bots fill hidden fields — accept and silently drop so they don't retry.
    if (honeypot && honeypot.trim() !== '') return { ok: true };

    const def = await this.getDefinition(token);
    const { database } = await this.resolve(token);

    // Enforce the form's own required flags (a form concern, not a DB constraint).
    const missing = def.fields
      .filter((f) => f.required)
      .filter((f) => {
        const v = values[f.api_name];
        return v == null || v === '' || (Array.isArray(v) && v.length === 0);
      })
      .map((f) => f.label);
    if (missing.length) {
      throw new UnprocessableEntityException(`Required: ${missing.join(', ')}`);
    }

    // Only accept values for fields the form actually exposes (ignore the rest).
    const allowed = new Set(def.fields.map((f) => f.api_name));
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(values)) if (allowed.has(k)) clean[k] = v;

    // Anonymous author: createdBy/actor is null (renders as a deactivated user).
    const created = await this.records.create(database.workspaceId, database.id, clean, null);
    return { ok: true, id: created.id };
  }
}
