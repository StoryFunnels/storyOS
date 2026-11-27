import { Inject, Injectable, UnprocessableEntityException } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { databases as databasesTable, fields as fieldsTable, spaces as spacesTable } from '../db/schema';
import { DatabasesService } from '../databases/databases.service';
import { DocumentsService } from '../documents/documents.service';
import { FieldsService } from '../fields/fields.service';
import { RecordsService } from '../records/records.service';
import { RelationsService } from '../relations/relations.service';
import type { Membership } from '../workspaces/workspace-access.guard';
import { RelationLinkerService } from '../migration-framework/relation-linker.service';
import { GithubService } from './github.service';
import { GithubWebhookService } from './github-webhook.service';
import { markdownToBlocks } from './markdown-to-blocks';
import {
  attachmentName,
  bodyIsOversize,
  classifyAttachmentUrl,
  contentHash,
  pullStateLabel,
  type DocumentRun,
  type LinearAttachment,
  type LinearDocument,
} from './linear-attachments';

/** A database row of the team's own pack, as `ensureTeamPack` returns it. */
interface PackDatabase {
  id: string;
  spaceId: string;
  restricted: boolean;
}

export interface ImportTeamExtras {
  membership: Membership;
  actorId: string;
  teamKey: string;
  issuesDb: PackDatabase;
  projectsDb: { id: string };
  /** Linear issue id → record id, for the issues this run wrote. */
  issueRecordIds: Map<string, string>;
  /** Linear issue id → record, for everything already mirrored before this run (places an attachment on an issue an incremental run did not rewrite). */
  mirrored: Map<string, { id: string }>;
  /** Linear project id → record id in this team's Projects database. */
  projectRecordIds: Map<string, string>;
  attachments: LinearAttachment[];
  /** Only the documents whose project is one of this team's. */
  documents: LinearDocument[];
  run: DocumentRun;
}

/**
 * Ticket #1366 — Linear attachments and project documents into StoryOS.
 *
 *  - A GitHub pull request attached to an issue becomes a record in the workspace's "GitHub Pull Requests" database, found by (repo, NUMBER),
 *    never by number alone, and linked to the issue through the same relation the GitHub webhook uses: so the webhook, when it later sees
 *    that PR, updates THIS record instead of making a second one. An existing PR record is never rewritten from a Linear attachment.
 *  - Every other attachment (a merge commit, a Figma file, an Enterprise PR) becomes a record in the team's own "Links" database.
 *  - Each project document becomes a record in the team's own "Documents" database, related to its project, with the Markdown as the
 *    record's description (so it keeps the description's version history).
 *
 * ACCESS. Both new databases live INSIDE the team's space, so they inherit its access like Issues and Projects do. The shared PR database
 * lives in the GitHub space, which may be open to people the team's space is not, so a team whose space or Issues database is RESTRICTED
 * never writes PR records there: its PR attachments stay in its own Links database (counted as `kept_in_team_space`).
 */
@Injectable()
export class LinearAttachmentsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly databasesService: DatabasesService,
    private readonly fields: FieldsService,
    private readonly recordsService: RecordsService,
    private readonly relationsService: RelationsService,
    private readonly relationLinker: RelationLinkerService,
    private readonly documentsService: DocumentsService,
    private readonly github: GithubService,
    private readonly githubWebhook: GithubWebhookService,
  ) {}

  async importTeam(args: ImportTeamExtras): Promise<void> {
    if (args.attachments.length > 0) await this.importAttachments(args);
    if (args.documents.length > 0) await this.importDocuments(args);
  }

  // ───────────────────────────────── attachments ─────────────────────────────────

  private async importAttachments(a: ImportTeamExtras): Promise<void> {
    const { run, membership, actorId } = a;
    const tally = run.attachments;
    tally.fetched += a.attachments.length;

    const space = await this.db.query.spaces.findFirst({ where: eq(spacesTable.id, a.issuesDb.spaceId) });
    // Fail closed: a space we cannot read counts as restricted (the PR record would otherwise go somewhere wider than we can vouch for).
    const restricted = !space || space.restricted || a.issuesDb.restricted;

    // Deterministic order, so a rerun writes in the same order and a failure is reproducible.
    const rows = [...a.attachments].sort((x, y) => x.createdAt.localeCompare(y.createdAt) || x.id.localeCompare(y.id));
    let links: { db: { id: string }; issueFieldId: string } | undefined;
    const linksFor = async () => (links ??= await this.ensureLinksDatabase(a));

    for (const att of rows) {
      const issueRecordId = a.issueRecordIds.get(att.issueId) ?? a.mirrored.get(att.issueId)?.id;
      if (!issueRecordId) {
        tally.unplaced++;
        run.warn('unplaced attachments', `team ${a.teamKey}: attachment ${att.id} is on an issue this run did not place (created after it was read); the next run picks it up`);
        continue;
      }
      const target = classifyAttachmentUrl(att.url);
      if (target.kind === 'unusable') {
        tally.unusable++;
        run.warn('unusable attachment URLs', `team ${a.teamKey}: attachment ${att.id} was not imported: ${target.reason}`);
        continue;
      }
      try {
        if (target.kind === 'pull_request' && !restricted) {
          const created = await this.linkPullRequest(a, att, target, issueRecordId);
          tally.pull_requests++;
          if (created) tally.pr_records_created++;
          continue;
        }
        const { db: linksDb, issueFieldId } = await linksFor();
        const url = target.url;
        const values: Record<string, unknown> = {
          name: attachmentName(att, url),
          url,
          source_type: att.sourceType ?? null,
          subtitle: att.subtitle ? att.subtitle.slice(0, 500) : null,
        };
        const existing = await this.findByLinearId(linksDb.id, att.id, actorId);
        const id = existing
          ? (await this.recordsService.update(membership.workspaceId, linksDb.id, existing.id, values, actorId, 0, 'import'), existing.id)
          : (await this.recordsService.create(membership.workspaceId, linksDb.id, { ...values, linear_id: att.id }, actorId, 0, 'import')).id;
        const failure = await this.relationLinker.set(membership.workspaceId, linksDb.id, id, issueFieldId, [issueRecordId], actorId);
        if (failure) throw new Error(failure);
        tally.links++;
        if (target.kind === 'pull_request') tally.kept_in_team_space++;
      } catch (error) {
        tally.failed++;
        run.warn('failed attachments', `team ${a.teamKey}: attachment ${att.id} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** Find-or-create the PR record by (repo, number), then link it to the issue. Returns whether the PR record is new. */
  private async linkPullRequest(
    a: ImportTeamExtras,
    att: LinearAttachment,
    pr: { repo: string; number: number; url: string },
    issueRecordId: string,
  ): Promise<boolean> {
    const { run, membership, actorId } = a;
    if (!run.pullsDb) {
      const { pullsDb } = await this.github.ensurePack(membership);
      run.pullsDb = pullsDb;
      run.pullStates = await this.github.optionIdsByLabel(pullsDb.id, 'state');
    }
    const pullsDb = run.pullsDb;

    let pullId = await this.findPull(pullsDb.id, pr.repo, pr.number, actorId);
    let created = false;
    if (!pullId) {
      const state = pullStateLabel(att.metadata);
      pullId = (
        await this.recordsService.create(
          membership.workspaceId,
          pullsDb.id,
          {
            name: attachmentName(att, `${pr.repo}#${pr.number}`),
            repo: pr.repo,
            number: pr.number,
            url: pr.url,
            ...(state && run.pullStates?.get(state) ? { state: run.pullStates.get(state) } : {}),
          },
          actorId,
          0,
          'import',
        )
      ).id;
      created = true;
    }

    // Link only when it is not linked already: a re-sync must not write a "linked" event per PR per run.
    const fieldId = await this.githubWebhook.findLinkField(pullsDb.id, a.issuesDb.id);
    if (fieldId) {
      const current = (await this.relationsService.listLinks(pullsDb.id, pullId, fieldId)).data.map((r) => r.id);
      if (current.includes(issueRecordId)) return created;
    }
    await this.githubWebhook.link(membership, pullsDb.id, pullId, { databaseId: a.issuesDb.id, recordId: issueRecordId });
    return created;
  }

  /**
   * The PR record for (repo, number). Matched on the PAIR: a number alone belongs to whichever repository numbered it first, and the same
   * number exists in every repository. The repo compares case-insensitively (GitHub names do); the number narrows the read, the repo decides.
   */
  private async findPull(pullsDbId: string, repo: string, number: number, actorId: string): Promise<string | null> {
    let cursor: string | undefined;
    for (;;) {
      const page = await this.recordsService.query(
        pullsDbId,
        { filter: { field: 'number', op: 'eq', value: number }, sorts: [], limit: 200, cursor } as never,
        actorId,
      );
      for (const r of page.data as Array<{ id: string; values: Record<string, unknown> }>) {
        const have = r.values['repo'];
        if (typeof have === 'string' && have.toLowerCase() === repo.toLowerCase()) return r.id;
      }
      if (!page.next_cursor) return null;
      cursor = page.next_cursor;
    }
  }

  // ───────────────────────────────── documents ─────────────────────────────────

  private async importDocuments(a: ImportTeamExtras): Promise<void> {
    const { run, membership, actorId } = a;
    const docs = await this.ensureDocumentsDatabase(a);
    for (const doc of [...a.documents].sort((x, y) => x.createdAt.localeCompare(y.createdAt) || x.id.localeCompare(y.id))) {
      run.target(doc.id);
      try {
        const projectRecordId = doc.project ? a.projectRecordIds.get(doc.project.id) : undefined;
        if (!projectRecordId) throw new Error('its project is not in this team');
        const hash = contentHash(doc.content);
        const prior = await this.findByLinearId(docs.db.id, doc.id, actorId);
        const priorHash = typeof prior?.values['linear_content_hash'] === 'string' ? (prior.values['linear_content_hash'] as string) : null;
        // The same rule an issue description follows: the body is written only into a BLANK description, so an edit made in StoryOS is
        // never replaced; Linear's later edits are flagged, not applied.
        const blank = prior ? (await this.documentsService.get(prior.id)).version === 0 : true;
        const changedInLinear = Boolean(prior) && !blank && priorHash !== null && priorHash !== hash;
        const classified = doc.url ? classifyAttachmentUrl(doc.url) : null;
        const values: Record<string, unknown> = {
          name: (doc.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 300) || 'Untitled document',
          author_name: doc.creator?.name ?? null,
          linear_created: doc.createdAt,
          linear_updated: doc.updatedAt,
          url: classified && classified.kind !== 'unusable' ? classified.url : null,
          linear_content_hash: hash,
          ...(changedInLinear ? { changed_in_linear: true } : {}),
        };
        let id: string;
        if (prior) {
          await this.recordsService.update(membership.workspaceId, docs.db.id, prior.id, values, actorId, 0, 'import');
          id = prior.id;
        } else {
          id = (await this.recordsService.create(membership.workspaceId, docs.db.id, { ...values, linear_id: doc.id }, actorId, 0, 'import')).id;
          run.created++;
        }
        if (changedInLinear) run.drift++;

        const failure = await this.relationLinker.set(membership.workspaceId, docs.db.id, id, docs.projectFieldId, [projectRecordId], actorId);
        if (failure) throw new Error(failure);

        if (blank && doc.content && doc.content.trim()) {
          if (bodyIsOversize(doc.content)) {
            run.oversize.push(doc.title);
            run.warn('oversize documents', `team ${a.teamKey}: document "${doc.title}" has a body over 2 MB, so its record was created WITHOUT the body (nothing was truncated)`);
          } else {
            const blocks = markdownToBlocks(doc.content);
            if (blocks.length > 0) {
              await this.documentsService.put(membership.workspaceId, docs.db.id, id, blocks, 0, actorId, 'import');
              run.bodyWritten++;
            }
          }
        }
        run.succeeded(doc.id);
      } catch (error) {
        run.warn('failed documents', `team ${a.teamKey}: document "${doc.title}" (${doc.id}) failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  // ───────────────────────────────── the databases ─────────────────────────────────

  private async findByLinearId(databaseId: string, linearId: string, actorId: string) {
    const page = await this.recordsService.query(
      databaseId,
      { filter: { field: 'linear_id', op: 'eq', value: linearId }, sorts: [], limit: 1 } as never,
      actorId,
    );
    return (page.data as Array<{ id: string; values: Record<string, unknown> }>)[0];
  }

  /**
   * One live database of the team's space for the importer's own use. Found by name AND by carrying a `linear_id` field (the importer's
   * own mark), so a database a person made and named "Documents" is never adopted: when the plain name is taken by one without the mark the
   * importer uses "<name> (Linear)", and refuses if that is taken too.
   */
  private async ensureOwnDatabase(
    membership: Membership,
    spaceId: string,
    name: string,
    icon: string,
    build: (database: { id: string }) => Promise<void>,
  ): Promise<{ id: string }> {
    const live = await this.db.query.databases.findMany({ where: and(eq(databasesTable.spaceId, spaceId), isNull(databasesTable.deletedAt)) });
    const marked = async (id: string) =>
      Boolean(await this.db.query.fields.findFirst({ where: and(eq(fieldsTable.databaseId, id), eq(fieldsTable.apiName, 'linear_id'), isNull(fieldsTable.deletedAt)) }));
    for (const candidate of [name, `${name} (Linear)`]) {
      const same = live.filter((d) => d.name === candidate);
      for (const d of same) if (await marked(d.id)) return d;
      if (same.length === 0) {
        const created = await this.databasesService.create(membership, { space_id: spaceId, name: candidate, icon });
        await build(created);
        return created;
      }
    }
    throw new UnprocessableEntityException(
      `The team space already has databases named "${name}" and "${name} (Linear)" that the Linear import did not create; rename one so the import can keep its ${name} there`,
    );
  }

  private async relationFieldId(databaseId: string, apiName: string): Promise<string> {
    const defs = await this.recordsService.fieldDefs(databaseId);
    const def = defs.find((d) => d.type === 'relation' && d.api_name === apiName);
    if (!def) throw new UnprocessableEntityException(`The "${apiName}" relation is missing from a Linear import database (renamed or deleted?); restore it so the import can link to it`);
    return def.id;
  }

  private async ensureLinksDatabase(a: ImportTeamExtras): Promise<{ db: { id: string }; issueFieldId: string }> {
    const db = await this.ensureOwnDatabase(a.membership, a.issuesDb.spaceId, 'Links', 'set:link', async (created) => {
      // `Linear ID` first: it is the mark that says this database is the importer's, so a half-built one is still recognised next run.
      for (const f of [
        { display_name: 'Linear ID', type: 'text' as const, config: {} },
        { display_name: 'URL', type: 'url' as const, config: {} },
        { display_name: 'Source Type', type: 'text' as const, config: {} },
        { display_name: 'Subtitle', type: 'text' as const, config: {} },
      ]) await this.fields.create(created.id, f);
      await this.relationsService.create(a.membership, {
        database_a_id: created.id, database_b_id: a.issuesDb.id,
        cardinality: 'one_to_many', field_a_name: 'Issue', field_b_name: 'Links',
      });
    });
    return { db, issueFieldId: await this.relationFieldId(db.id, 'issue') };
  }

  private async ensureDocumentsDatabase(a: ImportTeamExtras): Promise<{ db: { id: string }; projectFieldId: string }> {
    const db = await this.ensureOwnDatabase(a.membership, a.issuesDb.spaceId, 'Documents', 'set:file-text', async (created) => {
      for (const f of [
        { display_name: 'Linear ID', type: 'text' as const, config: {} },
        { display_name: 'Author (name)', type: 'text' as const, config: {} },
        { display_name: 'Linear Created', type: 'date' as const, config: { include_time: true } },
        { display_name: 'Linear Updated', type: 'date' as const, config: { include_time: true } },
        { display_name: 'URL', type: 'url' as const, config: {} },
        // What the sync compares to tell that Linear's text changed since it was imported (a hash, not a second copy of the body).
        { display_name: 'Linear Content Hash', type: 'text' as const, config: { entity_hidden: true } },
        { display_name: 'Changed in Linear', type: 'checkbox' as const, config: {} },
      ]) await this.fields.create(created.id, f);
      await this.relationsService.create(a.membership, {
        database_a_id: created.id, database_b_id: a.projectsDb.id,
        cardinality: 'one_to_many', field_a_name: 'Project', field_b_name: 'Documents',
      });
    });
    return { db, projectFieldId: await this.relationFieldId(db.id, 'project') };
  }
}
