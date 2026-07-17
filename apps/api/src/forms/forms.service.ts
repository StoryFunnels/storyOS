import {
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { databases, fields, selectOptions, views } from '../db/schema';
import { RecordsService } from '../records/records.service';

/** Field types a public form can render/accept (MN-101). */
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
    // Field order: the form's own list, else the view's card fields (back-compat).
    const orderIds = formFields.length
      ? formFields.map((f) => f.field_id)
      : ((view.config as { card_field_ids?: string[] }).card_field_ids ?? []);

    const chosen = orderIds
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

    return {
      title: form.title || database.name,
      description: form.description ?? null,
      submit_text: form.submit_text || 'Submit',
      success_message: form.success_message ?? null,
      redirect_url: form.redirect_url ?? null,
      fields: chosen.map((f) => ({
        field_id: f.id,
        api_name: f.apiName,
        type: f.type,
        label: cfgById.get(f.id)?.label || f.displayName,
        help: cfgById.get(f.id)?.help ?? null,
        required: cfgById.get(f.id)?.required ?? false,
        options: optsByField.get(f.id),
      })),
    };
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
