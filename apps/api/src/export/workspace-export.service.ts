import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Readable } from 'node:stream';
import archiver from 'archiver';
import { and, asc, eq, gt, inArray, isNull } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import {
  attachments,
  databases,
  recordLinks,
  records,
  relations,
  selectOptions,
  spaces,
  fields,
  workspaces,
} from '../db/schema';
import { getStorage } from '../attachments/storage';

/**
 * The format version this exporter writes. A future importer keys off this so an
 * older archive can be read (or refused) knowingly. Bump on a breaking layout
 * change — see docs/architecture/workspace-export.md.
 */
export const WORKSPACE_EXPORT_FORMAT = 'storyos-workspace-export';
export const WORKSPACE_EXPORT_VERSION = 1;

/** One page of records/links at a time — memory stays bounded on a huge workspace. */
const PAGE = 500;

type AttachmentRef = {
  id: string;
  filename: string;
  mime: string;
  size: number;
  /** Where the bytes live inside the archive — a record points here. */
  path: string;
  storageKey: string;
};

/**
 * Whole-workspace, owner-facing data export (#320) — StoryOS is a no-lock-in tool,
 * so an owner can take EVERYTHING out: spaces, databases, the field schema (types
 * + config + select options), every record with its raw values, the relation graph
 * (as stable record ids), and the attachment bytes.
 *
 * The whole thing STREAMS into a `.zip` (archiver): record pages and attachment
 * bytes are pulled one at a time as the archive is consumed, so a large workspace
 * doesn't get buffered into memory. Attachments go through the SAME storage seam
 * (MN-029, local disk or S3) the rest of the app reads through, so the export works
 * identically on both deployments.
 *
 * Layout (documented in docs/architecture/workspace-export.md):
 *   manifest.json                          — workspace meta, format version, index
 *   spaces/<space-slug>/<db-slug>.json     — schema + records (values keyed by field id)
 *   relations.json                         — relation defs + links, by record id
 *   attachments/<attachment-id>/<filename> — the actual files
 */
@Injectable()
export class WorkspaceExportService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Validate the workspace up front (404 before any bytes flow), then stream the zip. */
  async streamExport(workspaceId: string): Promise<{ filename: string; archive: Readable }> {
    const workspace = await this.db.query.workspaces.findFirst({
      where: eq(workspaces.id, workspaceId),
    });
    if (!workspace) throw new NotFoundException('Workspace not found');

    // Structural metadata is small and read eagerly; the bulk (records, links,
    // attachment bytes) is streamed lazily below as archiver consumes each entry.
    /**
     * #291/#290 — PERSONAL spaces are excluded from the export, unconditionally.
     *
     * The export is triggerable by an owner/admin, so including personal content
     * would make it the back door that "no admin bypass" exists to prevent — and a
     * silent one, since the ZIP is rarely read by the person whose notes are in it.
     * The accepted consequence is on the ticket: a departing member's personal docs
     * are not recoverable from an export either.
     */
    const spaceRows = await this.db.query.spaces.findMany({
      where: and(eq(spaces.workspaceId, workspaceId), eq(spaces.personal, false)),
      orderBy: [asc(spaces.position), asc(spaces.id)],
    });
    const databaseRows = (
      await this.db.query.databases.findMany({
        where: eq(databases.workspaceId, workspaceId),
        orderBy: [asc(databases.position), asc(databases.id)],
      })
      // #128: system databases (Members, the Agentic OS pack) are regenerable
      // projections provisioned per workspace, not user content — exporting a
      // stale membership mirror into a fresh workspace on import would be wrong.
      // Excluded here so the archive is the owner's actual data.
      //
      // #317: this used to filter on the NAME, which silently dropped a user's
      // own database if they happened to call it Members/Agents/Runs — their
      // data, missing from their export, with no warning. The flag only marks
      // what a service actually provisioned.
    ).filter((d) => !d.isSystem);
    const relationRows = await this.db.query.relations.findMany({
      where: eq(relations.workspaceId, workspaceId),
    });

    // Attachment metadata (not bytes): resolve every attachment in the workspace
    // through record → database, so each record can reference its files by a stable
    // in-archive path and we can stream the bytes at the end.
    const attachmentMetaRows = await this.db
      .select({
        id: attachments.id,
        recordId: attachments.recordId,
        filename: attachments.filename,
        mime: attachments.mime,
        size: attachments.size,
        storageKey: attachments.storageKey,
      })
      .from(attachments)
      .innerJoin(records, eq(attachments.recordId, records.id))
      .innerJoin(databases, eq(records.databaseId, databases.id))
      .where(eq(databases.workspaceId, workspaceId));

    const attachmentsByRecord = new Map<string, AttachmentRef[]>();
    const allAttachments: AttachmentRef[] = [];
    for (const a of attachmentMetaRows) {
      if (a.storageKey === 'pending') continue; // half-finished upload — no bytes to take
      const ref: AttachmentRef = {
        id: a.id,
        filename: a.filename,
        mime: a.mime,
        size: a.size,
        path: `attachments/${a.id}/${sanitize(a.filename)}`,
        storageKey: a.storageKey,
      };
      allAttachments.push(ref);
      const list = attachmentsByRecord.get(a.recordId) ?? [];
      list.push(ref);
      attachmentsByRecord.set(a.recordId, list);
    }

    // A slug can repeat if two databases collide after truncation; disambiguate the
    // folder path so no two databases ever fight over the same archive entry.
    const usedPaths = new Set<string>();
    const dbPath = new Map<string, string>();
    const spaceSlugById = new Map(spaceRows.map((s) => [s.id, sanitize(s.slug || s.id)]));
    for (const db of databaseRows) {
      const spaceSlug = spaceSlugById.get(db.spaceId) ?? sanitize(db.spaceId);
      const baseSlug = sanitize(db.apiSlug || db.id);
      let dbSlug = baseSlug;
      let path = `spaces/${spaceSlug}/${dbSlug}.json`;
      let n = 1;
      while (usedPaths.has(path)) {
        dbSlug = `${baseSlug}-${n++}`;
        path = `spaces/${spaceSlug}/${dbSlug}.json`;
      }
      usedPaths.add(path);
      dbPath.set(db.id, path);
    }

    const manifest = {
      format: WORKSPACE_EXPORT_FORMAT,
      format_version: WORKSPACE_EXPORT_VERSION,
      exported_at: new Date().toISOString(),
      workspace: { id: workspace.id, name: workspace.name, slug: workspace.slug },
      counts: {
        spaces: spaceRows.length,
        databases: databaseRows.length,
        relations: relationRows.length,
        attachments: allAttachments.length,
      },
      spaces: spaceRows.map((s) => ({
        id: s.id,
        name: s.name,
        slug: s.slug,
        icon: s.icon,
        color: s.color,
        databases: databaseRows
          .filter((d) => d.spaceId === s.id)
          .map((d) => ({ id: d.id, name: d.name, api_slug: d.apiSlug, path: dbPath.get(d.id)! })),
      })),
    };

    const archive = archiver('zip', { zlib: { level: 9 } });
    // Surface archiver's own problems on the stream so the request fails loudly
    // rather than shipping a silently-truncated zip. ENOENT warnings are benign
    // (an attachment vanished) — anything else is escalated to a hard error.
    archive.on('warning', (err) => {
      if ((err as { code?: string }).code !== 'ENOENT') archive.emit('error', err);
    });

    archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });

    // One JSON file per database: schema first, then records streamed page by page.
    for (const db of databaseRows) {
      archive.append(Readable.from(this.databaseJson(db, attachmentsByRecord)), {
        name: dbPath.get(db.id)!,
      });
    }

    // The relation graph, streamed: definitions (few) then links (potentially many).
    archive.append(Readable.from(this.relationsJson(relationRows)), { name: 'relations.json' });

    // Finally the attachment bytes, each pulled through the storage seam on demand.
    const storage = getStorage();
    for (const ref of allAttachments) {
      let stream: Readable;
      try {
        stream = await storage.getStream(ref.storageKey);
      } catch {
        // A missing object (deleted underneath us) must not abort the whole export —
        // the record's reference stays in the JSON, the bytes are simply absent.
        continue;
      }
      archive.append(stream, { name: ref.path });
    }

    // Fire-and-forget: archiver drains as the HTTP response is read.
    void archive.finalize();

    const date = new Date().toISOString().slice(0, 10);
    return {
      filename: `workspace-${sanitize(workspace.slug || workspace.id)}-${date}.zip`,
      archive,
    };
  }

  /** Stream a single database's schema + records as a JSON document. */
  private async *databaseJson(
    db: typeof databases.$inferSelect,
    attachmentsByRecord: Map<string, AttachmentRef[]>,
  ): AsyncGenerator<string> {
    const fieldRows = await this.db.query.fields.findMany({
      where: and(eq(fields.databaseId, db.id), isNull(fields.deletedAt)),
      orderBy: [asc(fields.position), asc(fields.id)],
    });
    const options = fieldRows.length
      ? await this.db.query.selectOptions.findMany({
          where: inArray(
            selectOptions.fieldId,
            fieldRows.map((f) => f.id),
          ),
          orderBy: [asc(selectOptions.position)],
        })
      : [];
    const optionsByField = new Map<string, typeof options>();
    for (const o of options) {
      const list = optionsByField.get(o.fieldId) ?? [];
      list.push(o);
      optionsByField.set(o.fieldId, list);
    }

    const schema = {
      database: {
        id: db.id,
        name: db.name,
        api_slug: db.apiSlug,
        space_id: db.spaceId,
        icon: db.icon,
        color: db.color,
        position: db.position,
      },
      fields: fieldRows.map((f) => ({
        id: f.id,
        display_name: f.displayName,
        api_name: f.apiName,
        type: f.type,
        config: f.config,
        position: f.position,
        is_system: f.isSystem,
        options: (optionsByField.get(f.id) ?? []).map((o) => ({
          id: o.id,
          label: o.label,
          color: o.color,
          position: o.position,
        })),
      })),
    };

    // `{ ...schema }` reopened as `{ ...schema, "records": [ ...records ] }`.
    const head = JSON.stringify(schema);
    yield `${head.slice(0, -1)},"records":[`;

    let cursor: string | undefined;
    let first = true;
    for (;;) {
      const page = await this.db.query.records.findMany({
        where: and(
          eq(records.databaseId, db.id),
          isNull(records.deletedAt),
          cursor ? gt(records.id, cursor) : undefined,
        ),
        orderBy: [asc(records.id)],
        limit: PAGE,
      });
      if (page.length === 0) break;
      let chunk = '';
      for (const r of page) {
        const obj = {
          id: r.id,
          number: r.number,
          title: r.title,
          position: r.position,
          values: r.values,
          created_by: r.createdBy,
          created_at: r.createdAt,
          updated_at: r.updatedAt,
          attachments: (attachmentsByRecord.get(r.id) ?? []).map((a) => ({
            id: a.id,
            filename: a.filename,
            mime: a.mime,
            size: a.size,
            path: a.path,
          })),
        };
        chunk += (first ? '' : ',') + JSON.stringify(obj);
        first = false;
      }
      yield chunk;
      cursor = page[page.length - 1]!.id;
      if (page.length < PAGE) break;
    }
    yield ']}';
  }

  /** Stream the relation graph: definitions, then links, keyed by stable record ids. */
  private async *relationsJson(
    relationRows: Array<typeof relations.$inferSelect>,
  ): AsyncGenerator<string> {
    const defs = relationRows.map((r) => ({
      id: r.id,
      database_a_id: r.databaseAId,
      database_b_id: r.databaseBId,
      field_a_id: r.fieldAId,
      field_b_id: r.fieldBId,
      cardinality: r.cardinality,
    }));
    yield `{"relations":${JSON.stringify(defs)},"links":[`;

    let first = true;
    for (const rel of relationRows) {
      let cursor: string | undefined;
      for (;;) {
        const page = await this.db.query.recordLinks.findMany({
          where: and(
            eq(recordLinks.relationId, rel.id),
            cursor ? gt(recordLinks.id, cursor) : undefined,
          ),
          orderBy: [asc(recordLinks.id)],
          limit: PAGE,
        });
        if (page.length === 0) break;
        let chunk = '';
        for (const l of page) {
          const obj = {
            relation_id: l.relationId,
            from_record_id: l.fromRecordId,
            to_record_id: l.toRecordId,
          };
          chunk += (first ? '' : ',') + JSON.stringify(obj);
          first = false;
        }
        yield chunk;
        cursor = page[page.length - 1]!.id;
        if (page.length < PAGE) break;
      }
    }
    yield ']}';
  }
}

/**
 * A filesystem-safe archive path segment: no slashes, no traversal, no control
 * chars. A user-set filename or slug reaches a zip entry name here, and a `../`
 * or absolute path in an entry name is a classic zip-slip on extraction.
 */
function sanitize(name: string): string {
  const cleaned = name
    // eslint-disable-next-line no-control-regex
    .replace(/[/\\\x00-\x1f]+/g, '_')
    .replace(/\.\.+/g, '_')
    .replace(/^\.+/, '')
    .trim();
  return cleaned.length ? cleaned.slice(0, 200) : 'unnamed';
}
