import { ForbiddenException, HttpException, Inject, Injectable, Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { AutomationAction } from '@storyos/schemas';
import { AttachmentsService } from '../attachments/attachments.service';
import { codedException } from '../common/coded-exception';
import { env } from '../config/env';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { attachments, databases, documents, fields, memberships, records, selectOptions, spaces, user } from '../db/schema';
import type { ChangeSource } from '../db/schema';
import { PdfRenderer } from '../documents/export/pdf-renderer';
import { renderBlocksToPdf } from '../documents/export/render-blocks-pdf';
import { RecordsService } from '../records/records.service';
import type { ProjectedRecord } from '../records/records.service';
import type { Membership } from '../workspaces/workspace-access.guard';
import { recordToBlocks, safePdfFilename } from './attach-pdf-model';
import type { PdfFieldDef } from './attach-pdf-model';

export type AttachPdfAction = Extract<AutomationAction, { type: 'attach_pdf' }>;

/** How many of ONE workspace's automation renders may be running or waiting. Ruling on ticket #877, answer 5. */
export const PDF_QUEUE_LIMIT_PER_WORKSPACE = 25;

export interface AttachPdfContext {
  workspaceId: string;
  databaseId: string;
  /** The triggering record. attach_pdf is refused at save time on a rule that has none. */
  record: ProjectedRecord;
  /** The rule's owner (automations.created_by), or the person who pressed a button. */
  actorId: string;
  source: ChangeSource;
}

export interface AttachPdfEffect {
  type: 'attach_pdf' | 'skipped';
  record_id: string;
  summary: string;
}

/**
 * Ticket #877 — render a record (or the one record it links to) as a PDF and attach it to an attachment field on the
 * triggering record.
 *
 * WHOSE ACCESS. The actor's, re-resolved from `memberships` on every run and checked through the SAME check the HTTP routes use
 * (`RecordsService.assertRecordAccess`): the source must be readable (`viewer`), the target record writable by the rung a manual
 * upload needs (`editor`). The renderer is only reached AFTER both pass, so a record the actor cannot read is never turned into
 * a file; there is no code path from "refused" to "rendered". This is stricter than every other action, which checks access when
 * the rule is saved and not again (ticket #877's actor finding).
 *
 * WHAT A FAILURE SAYS. The run row is read by whoever can see the rule's runs, who may not be able to read what was refused, so
 * a refusal names the actor and the KIND of thing ("the linked record"), never its title or contents.
 *
 * NO PARTIAL ATTACHMENT. The PDF is rendered into memory, size-checked, and only then written; a replaced file is removed only
 * AFTER its replacement is in place, so a failure never leaves the field with less than it had.
 */
@Injectable()
export class AttachPdfActionService {
  private readonly log = new Logger(AttachPdfActionService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly recordsService: RecordsService,
    private readonly attachmentsService: AttachmentsService,
    private readonly pdf: PdfRenderer,
  ) {}

  /** Save-time shape check: the target is an attachment field of THIS database, the relation is one of its relation fields. */
  async validate(workspaceId: string, databaseId: string, action: AttachPdfAction): Promise<void> {
    if (action.require_approval === true) {
      throw new UnprocessableEntityException('attach_pdf cannot be held for approval: it writes a file onto the record and sends nothing out.');
    }
    const target = await this.db.query.fields.findFirst({
      where: and(eq(fields.id, action.target_field_id), eq(fields.databaseId, databaseId), isNull(fields.deletedAt)),
    });
    if (!target) throw new UnprocessableEntityException('attach_pdf target_field_id must be a field on this database');
    if (target.type !== 'attachment') {
      throw new UnprocessableEntityException(`attach_pdf target field "${target.displayName}" is not an attachment field`);
    }
    if (action.source.kind === 'linked_record') {
      const relationFieldId = action.source.relation_field_id;
      const relation = await this.db.query.fields.findFirst({
        where: and(eq(fields.id, relationFieldId), eq(fields.databaseId, databaseId), isNull(fields.deletedAt)),
      });
      if (!relation || relation.type !== 'relation') {
        throw new UnprocessableEntityException('attach_pdf source.relation_field_id must be a relation field on this database');
      }
    }
    const database = await this.db.query.databases.findFirst({
      where: and(eq(databases.id, databaseId), eq(databases.workspaceId, workspaceId)),
      columns: { isSystem: true },
    });
    if (database?.isSystem) {
      throw new UnprocessableEntityException('attach_pdf cannot run on a system database');
    }
  }

  /**
   * Ruling on ticket #877, answer 4: a rule that makes PDFs cannot be switched ON while the renderer is not usable. Saving it
   * switched off is fine. `status()` asks the sidecar's own health check (cached a few seconds), so "configured but dead" is
   * refused too. Run time still fails loudly on its own; this is the earlier, kinder place to say it.
   */
  async assertRendererForEnabled(actions: ReadonlyArray<{ type?: unknown }>): Promise<void> {
    if (!actions.some((a) => a.type === 'attach_pdf')) return;
    const status = await this.pdf.status();
    if (!status.available) {
      throw new UnprocessableEntityException({
        code: 'pdf_export_unavailable',
        message: status.configured
          ? 'The PDF renderer is not answering, so a rule that attaches a PDF cannot be switched on yet. You can save it switched off.'
          : 'PDF export is not set up on this server, so a rule that attaches a PDF cannot be switched on. You can save it switched off; an administrator has to run the PDF renderer first.',
      });
    }
  }

  async run(action: AttachPdfAction, ctx: AttachPdfContext, renderedFilename: string): Promise<AttachPdfEffect> {
    try {
      return await this.runUnchecked(action, ctx, renderedFilename);
    } catch (error) {
      if (error instanceof HttpException) throw this.prefixed(error);
      // Anything else is a bug or an outage; its text can carry SQL or paths, so it goes to the log and not to the run row.
      this.log.error(`attach_pdf failed unexpectedly: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      throw codedException(500, 'attach_pdf_failed', 'No PDF was made: something went wrong on the server. Nothing was attached.');
    }
  }

  /** Same status, code and meta, with the one sentence a person reading the run needs: nothing was made. */
  private prefixed(error: HttpException): HttpException {
    const body = error.getResponse();
    const message = typeof body === 'string' ? body : ((body as { message?: unknown }).message ?? error.message);
    const text = String(message);
    const code = typeof body === 'object' && body !== null ? (body as { code?: string }).code : undefined;
    const meta = typeof body === 'object' && body !== null ? (body as { meta?: Record<string, unknown> }).meta : undefined;
    return codedException(error.getStatus(), code ?? 'attach_pdf_failed', text.startsWith('No PDF was made') ? text : `No PDF was made: ${text}`, meta);
  }

  private async runUnchecked(action: AttachPdfAction, ctx: AttachPdfContext, renderedFilename: string): Promise<AttachPdfEffect> {
    // 1. Loud when there is no renderer. Checked first so nothing else is read for a render that cannot happen.
    if (!this.pdf.configured) {
      throw codedException(
        503,
        'pdf_export_not_configured',
        'PDF export is not configured on this server. An administrator has to run the PDF renderer first.',
      );
    }

    // 2. Who is acting, as a membership read NOW. A creator who has since left, or a rule with no creator, renders nothing.
    const membership = await this.actorMembership(ctx);
    const actorName = await this.actorName(ctx.actorId);

    // 3. The target: the triggering record, writable by the actor, in a normal (non-system, non-personal) database.
    const targetDb = await this.databaseRow(ctx.workspaceId, ctx.databaseId);
    if (!targetDb) throw new NotFoundException('The database is gone.');
    this.assertNormalHome(targetDb, 'this record', actorName);
    await this.assertAccess(membership, ctx.databaseId, ctx.record.id, 'editor', `${actorName} cannot edit this record, so no file can be attached to it.`);
    const targetField = await this.db.query.fields.findFirst({
      where: and(eq(fields.id, action.target_field_id), eq(fields.databaseId, ctx.databaseId), isNull(fields.deletedAt)),
    });
    if (!targetField || targetField.type !== 'attachment') {
      throw codedException(422, 'attach_pdf_bad_target', 'The target field is not an attachment field on this database any more.');
    }

    // 4. The source: this record, or exactly one record it links to. Readable by the actor, or it is not rendered.
    const source = await this.resolveSource(action, ctx, membership, actorName);

    // 5. Already there? `skip` (the default) stops a re-run of the same trigger before any rendering is paid for.
    const filename = safePdfFilename(renderedFilename);
    const mode = action.if_exists ?? 'skip';
    if (mode === 'skip') {
      const existing = await this.existingNamed(ctx.record.id, targetField.id, filename);
      if (existing.length > 0) {
        return { type: 'skipped', record_id: ctx.record.id, summary: `Skipped attach_pdf: "${filename}" is already in ${targetField.displayName}` };
      }
    }

    // 6. Draw the source exactly as the actor sees it, and render. The queue is this workspace's alone.
    const view = await this.recordsService.get(source.databaseId, source.id, membership);
    const blocks = recordToBlocks({
      fields: await this.liveFields(source.databaseId),
      values: view.values,
      optionLabels: await this.optionLabels(source.databaseId),
      userNames: await this.userNames(ctx.workspaceId, view.values),
      description: source.descriptionHidden ? null : await this.descriptionBlocks(source.id),
    });
    const { pdf } = await renderBlocksToPdf(
      { db: this.db, pdf: this.pdf },
      { workspaceId: ctx.workspaceId, title: view.title, blocks, queue: { key: ctx.workspaceId, limit: PDF_QUEUE_LIMIT_PER_WORKSPACE } },
    );

    // 7. Size, BEFORE anything is written.
    const max = env().ATTACHMENT_MAX_BYTES;
    if (pdf.length > max) {
      throw codedException(
        413,
        'pdf_too_large_to_attach',
        `The PDF is ${Math.ceil(pdf.length / 1024 / 1024)} MB and a file on a record can be at most ${Math.round(max / 1024 / 1024)} MB.`,
        { limit_bytes: max, size_bytes: pdf.length },
      );
    }

    // 8. The queue may have taken a while: look again, so two firings that both passed step 5 do not both attach.
    if (mode === 'skip' && (await this.existingNamed(ctx.record.id, targetField.id, filename)).length > 0) {
      return { type: 'skipped', record_id: ctx.record.id, summary: `Skipped attach_pdf: "${filename}" is already in ${targetField.displayName}` };
    }
    const replaced = mode === 'replace' ? await this.existingNamed(ctx.record.id, targetField.id, filename) : [];

    // 9. Write, attributed to the actor with the run's source ('automation'); upload() records the activity event.
    const stored = await this.attachmentsService.upload(
      ctx.workspaceId,
      ctx.record.id,
      { filename, mime: 'application/pdf', data: pdf },
      ctx.actorId,
      targetField.id,
      ctx.source,
    );
    // Only now is the old file let go, so a failed render or upload never costs the field the file it had.
    for (const old of replaced) {
      if (old.id !== stored.id) await this.attachmentsService.remove(ctx.workspaceId, ctx.record.id, old.id, ctx.actorId);
    }
    return {
      type: 'attach_pdf',
      record_id: ctx.record.id,
      summary: `Attached "${filename}" (${Math.max(1, Math.round(pdf.length / 1024))} KB) to ${targetField.displayName}${replaced.length ? ' (replaced the earlier file)' : ''}`,
    };
  }

  /** The actor as an ACTIVE member of this workspace, or a refusal that says nobody can be named. */
  private async actorMembership(ctx: AttachPdfContext): Promise<Membership> {
    const row = await this.db.query.memberships.findFirst({
      where: and(eq(memberships.workspaceId, ctx.workspaceId), eq(memberships.userId, ctx.actorId), eq(memberships.status, 'active')),
    });
    if (!row) {
      throw codedException(
        403,
        'attach_pdf_no_owner',
        'This rule has no owner who is an active member of the workspace, so there is no one whose access could be used to make a PDF.',
      );
    }
    return row;
  }

  private async actorName(userId: string): Promise<string> {
    const row = await this.db.query.user.findFirst({ where: eq(user.id, userId), columns: { name: true } });
    return row?.name?.trim() || 'The rule owner';
  }

  private async databaseRow(workspaceId: string, databaseId: string) {
    const [row] = await this.db
      .select({
        id: databases.id,
        spaceId: databases.spaceId,
        isSystem: databases.isSystem,
        descriptionHidden: databases.descriptionHidden,
        personal: spaces.personal,
      })
      .from(databases)
      .innerJoin(spaces, eq(spaces.id, databases.spaceId))
      .where(and(eq(databases.id, databaseId), eq(databases.workspaceId, workspaceId), isNull(databases.deletedAt)))
      .limit(1);
    return row;
  }

  /** System databases (people, agents) and personal space are never a source or a target: they were not built to leave the app as a file. */
  private assertNormalHome(row: { isSystem: boolean; personal: boolean | null }, what: string, actorName: string): void {
    if (row.isSystem || row.personal) {
      throw codedException(403, 'attach_pdf_not_allowed', `${actorName} cannot make a PDF of ${what}: it lives in a place PDFs are never made from.`);
    }
  }

  /** The ONE access check (the HTTP routes' own), turned into a refusal that names the actor and the kind of thing, not its contents. */
  private async assertAccess(membership: Membership, databaseId: string, recordId: string, min: 'viewer' | 'editor', message: string): Promise<void> {
    try {
      await this.recordsService.assertRecordAccess(membership, databaseId, recordId, min);
    } catch (error) {
      if (error instanceof NotFoundException || error instanceof ForbiddenException) {
        throw codedException(403, 'attach_pdf_no_access', message);
      }
      throw error;
    }
  }

  private async resolveSource(
    action: AttachPdfAction,
    ctx: AttachPdfContext,
    membership: Membership,
    actorName: string,
  ): Promise<{ id: string; databaseId: string; descriptionHidden: boolean }> {
    const here = await this.databaseRow(ctx.workspaceId, ctx.databaseId);
    if (action.source.kind === 'record') {
      await this.assertAccess(membership, ctx.databaseId, ctx.record.id, 'viewer', `${actorName} cannot read this record, so it was not rendered.`);
      return { id: ctx.record.id, databaseId: ctx.databaseId, descriptionHidden: here?.descriptionHidden ?? false };
    }
    const relationField = await this.db.query.fields.findFirst({
      where: and(eq(fields.id, action.source.relation_field_id), eq(fields.databaseId, ctx.databaseId), isNull(fields.deletedAt)),
    });
    if (!relationField || relationField.type !== 'relation') {
      throw codedException(422, 'attach_pdf_bad_source', 'The relation field the PDF should be made from is gone.');
    }
    // The ids come from the triggering record's own link chips, not from anything the actor can see: "no link" and "a link the
    // actor cannot read" must stay different failures.
    const chips = (ctx.record.values[relationField.apiName] as Array<{ id: string }> | undefined) ?? [];
    if (chips.length === 0) {
      throw codedException(422, 'attach_pdf_no_linked_record', `The record has nothing in "${relationField.displayName}", so there is no record to make a PDF of.`);
    }
    if (chips.length > 1) {
      throw codedException(
        422,
        'attach_pdf_ambiguous_source',
        `"${relationField.displayName}" links ${chips.length} records and attach_pdf needs exactly one; no PDF was chosen for you.`,
      );
    }
    const linkedId = chips[0]!.id;
    const [linked] = await this.db
      .select({ id: records.id, databaseId: records.databaseId })
      .from(records)
      .where(and(eq(records.id, linkedId), isNull(records.deletedAt)))
      .limit(1);
    const home = linked ? await this.databaseRow(ctx.workspaceId, linked.databaseId) : undefined;
    if (!linked || !home) {
      throw codedException(403, 'attach_pdf_no_access', `${actorName} cannot read the linked record, so it was not rendered.`);
    }
    this.assertNormalHome(home, 'the linked record', actorName);
    await this.assertAccess(membership, linked.databaseId, linked.id, 'viewer', `${actorName} cannot read the linked record, so it was not rendered.`);
    return { id: linked.id, databaseId: linked.databaseId, descriptionHidden: home.descriptionHidden };
  }

  private async existingNamed(recordId: string, fieldId: string, filename: string) {
    return this.db.query.attachments.findMany({
      where: and(eq(attachments.recordId, recordId), eq(attachments.fieldId, fieldId), eq(attachments.filename, filename)),
      orderBy: [asc(attachments.createdAt)],
      columns: { id: true },
    });
  }

  private async liveFields(databaseId: string): Promise<PdfFieldDef[]> {
    const rows = await this.db.query.fields.findMany({ where: and(eq(fields.databaseId, databaseId), isNull(fields.deletedAt)) });
    return rows.map((f) => ({
      id: f.id,
      apiName: f.apiName,
      displayName: f.displayName,
      type: f.type,
      position: f.position,
      isSystem: f.isSystem,
      config: (f.config ?? {}) as Record<string, unknown>,
    }));
  }

  private async optionLabels(databaseId: string): Promise<Map<string, string>> {
    const rows = await this.db
      .select({ id: selectOptions.id, label: selectOptions.label })
      .from(selectOptions)
      .innerJoin(fields, eq(fields.id, selectOptions.fieldId))
      .where(eq(fields.databaseId, databaseId));
    return new Map(rows.map((r) => [r.id, r.label]));
  }

  private async userNames(workspaceId: string, values: Record<string, unknown>): Promise<Map<string, string>> {
    const ids = new Set<string>();
    for (const v of Object.values(values)) {
      for (const item of Array.isArray(v) ? v : [v]) if (typeof item === 'string' && item.length > 8 && item.length < 64) ids.add(item);
    }
    if (ids.size === 0) return new Map();
    const rows = await this.db
      .select({ id: user.id, name: user.name })
      .from(user)
      .innerJoin(memberships, and(eq(memberships.userId, user.id), eq(memberships.workspaceId, workspaceId)))
      .where(inArray(user.id, [...ids]));
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  private async descriptionBlocks(recordId: string): Promise<unknown> {
    const row = await this.db.query.documents.findFirst({ where: eq(documents.recordId, recordId), columns: { content: true } });
    return row?.content ?? null;
  }
}
