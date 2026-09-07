import {
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  isFormFieldVisible,
  visibleFormFields,
  type FilterNode,
  type FormVisibilityRule,
  type PublicFormVisibilityRule,
} from '@storyos/schemas';
import { BillingService } from '../billing/billing.service';
import { resolveDatabaseColor } from '../common/database-color';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { databases, fields, memberships, records, relations, selectOptions, user, views } from '../db/schema';
import { RecordsService } from '../records/records.service';
import { compileFilter } from '../records/query-compiler';
import { cleanFilterNode } from '../views/views.service';

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
  'workflow',
  'user',
  'relation',
]);

interface FormFieldCfg {
  field_id: string;
  required?: boolean;
  label?: string;
  help?: string;
  /** #263 — show this field only when an earlier answer matches. */
  visible_when?: FormVisibilityRule;
  /** #500 — `required` only bites when this also holds (or is unset). */
  required_when?: FormVisibilityRule;
  /** #501 — narrows a relation field's picker; compiled against the relation's
   *  TARGET database (never this form's own) — see `searchRelationCandidates`. */
  relation_filter?: FilterNode;
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
    // #347: a view's databaseId is nullable now (a dashboard composes queries and
    // owns no database). A FORM writes records into one, so a form view without a
    // database is not a form — same not-found answer as an unpublished one, rather
    // than leaking that the token resolved to something.
    if (!view.databaseId) throw new NotFoundException('Form not found');
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
      .filter((f) => f.type === 'select' || f.type === 'multi_select' || f.type === 'workflow')
      .map((f) => f.id);
    const options = selectIds.length
      ? await this.db.query.selectOptions.findMany({
          where: inArray(selectOptions.fieldId, selectIds),
          orderBy: [asc(selectOptions.position)],
        })
      : [];
    // #303: carry `color`/`icon` so the public form can render the SAME coloured
    // option chip the app uses (table cells, board cards, record page) instead of a
    // native <select>. These are workspace SCHEMA, not personal data — unlike member
    // avatars, which are deliberately still withheld from this unauthenticated
    // payload (see `workspaceMembers` below).
    const optsByField = new Map<
      string,
      { id: string; label: string; color: string; icon: string | null }[]
    >();
    for (const o of options) {
      const list = optsByField.get(o.fieldId) ?? [];
      list.push({ id: o.id, label: o.label, color: o.color, icon: o.icon ?? null });
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
        relation_filter?: FilterNode;
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
        relation_filter: cfgById.get(f.id)?.relation_filter,
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

    // #263 — translate visibility rules from internal field ids to api_names, and
    // keep ONLY rules whose controlling field this form exposes EARLIER in the
    // order. Walking in order is what makes "depends on an earlier answer" true
    // rather than merely intended, and it makes a rule cycle impossible by
    // construction (a field can never control itself or anything before it).
    const visibleWhenByField = new Map<string, PublicFormVisibilityRule>();
    // #500 — `required_when` is translated by the exact same earlier-only rule,
    // since it's the same rule shape gating a different thing (required, not shown).
    const requiredWhenByField = new Map<string, PublicFormVisibilityRule>();
    const seenApiNames = new Set<string>();
    const translateEarlierRule = (rule: FormVisibilityRule | undefined): PublicFormVisibilityRule | undefined => {
      const controller = rule ? chosen.find((c) => c.id === rule.field_id) : undefined;
      if (!rule || !controller || !seenApiNames.has(controller.apiName)) return undefined;
      return { field: controller.apiName, op: rule.op, value: rule.value };
    };
    for (const f of chosen) {
      const cfg = cfgById.get(f.id);
      const visibleWhen = translateEarlierRule(cfg?.visible_when);
      if (visibleWhen) visibleWhenByField.set(f.id, visibleWhen);
      const requiredWhen = translateEarlierRule(cfg?.required_when);
      if (requiredWhen) requiredWhenByField.set(f.id, requiredWhen);
      seenApiNames.add(f.apiName);
    }

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
        // #263 — rendered keyed by api_name, which is what the renderer matches
        // against its own answer keys. A rule pointing at a field this form
        // doesn't expose (or one
        // that isn't EARLIER in the order) is dropped rather than served: a
        // dangling reference the renderer can't evaluate would hide the field
        // forever. Dropping only the DANGLING case, not merely-unconfigured ones.
        visible_when: visibleWhenByField.get(f.id),
        // #500 — same dangling/forward-reference dropping as visible_when above.
        required_when: requiredWhenByField.get(f.id),
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
    const { target_database_id, relation_filter } = await this.resolveRelationField(token, fieldId);
    if (!relation_filter) {
      const page = await this.records.list(target_database_id, { limit: 20, q });
      return page.data.map((r) => ({ id: r.id, title: r.title, number: r.number }));
    }
    // #501 — narrows the picker to the form owner's stored filter, compiled
    // against the TARGET database's live fields. Defensively cleaned first
    // (same as a view's own `filters`, cleanFilterNode) so a field the target
    // database has since dropped degrades to a narrower-but-working filter
    // rather than throwing at a public, unauthenticated visitor.
    const targetFields = await this.records.fieldDefs(target_database_id);
    const liveApiNames = new Set(targetFields.map((f) => f.api_name));
    const cleaned = cleanFilterNode(relation_filter, liveApiNames) as typeof relation_filter | undefined;
    const page = await this.records.query(
      target_database_id,
      { filter: cleaned, sorts: [], q, limit: 20 },
      // No signed-in visitor to resolve a "me" condition against — compileFilter
      // only reads this for user/created_by/updated_by conditions, where it
      // will simply never match a real id rather than crashing.
      '',
    );
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

    // #263 — resolve which fields the submitted answers actually reveal. This is
    // the SAME evaluator the renderer uses (packages/schemas), so the browser and
    // the server can't drift into disagreeing about what was on screen.
    const visible = visibleFormFields(def.fields, values);
    const visibleNames = new Set(visible.map((f) => f.api_name));

    // Enforce the form's own required flags (a form concern, not a DB constraint)
    // — but only for fields the submitter could actually SEE. A required field
    // hidden by its own rule would otherwise make the form unsubmittable, which
    // is the obvious way conditional forms break.
    // #500 — `required` alone is no longer the full story: a field's own
    // required_when (the SAME evaluator visibility already trusts) can turn its
    // required-ness off even while the field itself stays visible. Independently
    // re-derived here rather than trusting a client claim, same reasoning as
    // `visible` above.
    const missing = visible
      .filter((f) => f.required && isFormFieldVisible(f.required_when, values))
      .filter((f) => {
        const v = values[f.api_name];
        return v == null || v === '' || (Array.isArray(v) && v.length === 0);
      })
      .map((f) => f.label);
    if (missing.length) {
      throw new UnprocessableEntityException(`Required: ${missing.join(', ')}`);
    }

    // Only accept values for fields the form exposes AND the rules reveal (#263):
    // a hidden field's value is refused server-side, so hiding is a real gate and
    // not merely a client-side courtesy a crafted POST could walk straight past.
    const allowed = visibleNames;
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(values)) if (allowed.has(k)) clean[k] = v;

    // #501 (Vera's AC5 finding) — a relation_filter narrows the SEARCH endpoint
    // only; nothing stopped a crafted POST naming a filtered-out id directly,
    // skipping the search step entirely. Re-derive the same filter here and
    // reject any submitted id that doesn't satisfy it, server-side, before the
    // record (and its link) is ever created.
    await this.enforceRelationFilters(
      def.fields.filter((f) => visibleNames.has(f.api_name)),
      clean,
    );

    // Anonymous author: createdBy/actor is null (renders as a deactivated user).
    const created = await this.records.create(database.workspaceId, database.id, clean, null);
    return { ok: true, id: created.id };
  }

  /**
   * #501 — the write-path counterpart to `searchRelationCandidates`'s read-path
   * narrowing. Re-derives each visible relation field's `relation_filter` the
   * SAME way (cleaned against the target database's live fields) and rejects
   * any submitted id that isn't both present in the target database and a
   * match for the filter. A field with no filter, or one that cleans away to
   * nothing (dangling reference), is left unrestricted — same degrade as the
   * search path.
   */
  private async enforceRelationFilters(
    visibleFields: Awaited<ReturnType<FormsService['getDefinition']>>['fields'],
    clean: Record<string, unknown>,
  ) {
    for (const f of visibleFields) {
      if (f.type !== 'relation' || !f.relation?.relation_filter) continue;
      const raw = clean[f.api_name];
      if (raw == null) continue;
      const ids = (Array.isArray(raw) ? raw : [raw]).filter((v): v is string => typeof v === 'string');
      if (!ids.length) continue;

      const targetDefs = await this.records.fieldDefs(f.relation.target_database_id);
      const liveApiNames = new Set(targetDefs.map((d) => d.api_name));
      const cleaned = cleanFilterNode(f.relation.relation_filter, liveApiNames) as FilterNode | undefined;
      if (!cleaned) continue;
      const byApiName = new Map(targetDefs.map((d) => [d.api_name, d]));
      const condition = compileFilter(cleaned, { defs: byApiName, currentUserId: '' });

      const matches = await this.db
        .select({ id: records.id })
        .from(records)
        .where(
          and(
            eq(records.databaseId, f.relation.target_database_id),
            isNull(records.deletedAt),
            inArray(records.id, ids),
            condition,
          ),
        );
      const matchedIds = new Set(matches.map((m) => m.id));
      if (ids.some((id) => !matchedIds.has(id))) {
        throw new UnprocessableEntityException(
          `"${f.label ?? f.api_name}" contains a value that is not allowed`,
        );
      }
    }
  }
}
