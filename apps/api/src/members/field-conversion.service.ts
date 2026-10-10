import { ConflictException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { databases, fields, memberships as memberships_, recordLinks, records, relations, views } from '../db/schema';
import { AccessService } from '../access/access.service';
import { DatabasesService } from '../databases/databases.service';
import { FieldsService } from '../fields/fields.service';
import { RecordsService } from '../records/records.service';
import { RelationsService } from '../relations/relations.service';
import { MembersDbService } from './members-db.service';
import type { Membership } from '../workspaces/workspace-access.guard';

/**
 * #597 — the first implementation of ADR-0012's guided conversion: a `user` field <-> a relation to the
 * Members database, in both directions, dry run first.
 *
 * Matching is EXACT (a user field stores user ids; Members rows carry the user id), so there is no
 * ambiguous bucket and no fuzzy match. The hard rule from ADR-0012 carries over: a value is NEVER
 * silently dropped. On the way in, the original user field is RETAINED (renamed "<name> (user)") and
 * is the parked copy; on the way out, a Members row with no user id is parked in a text field.
 *
 * Why the original keeps its api_name and the relation gets a new one: record values are keyed by
 * field id, but saved views, automations and API clients address a field by api_name. Moving the
 * name would silently repoint every one of them at a different field type, which is worse than
 * leaving them on the retained field until a person repoints them.
 */

const SAMPLE = 20;
const CHUNK = 1000;
const MARK = 'converted_to_relation_id';

type FieldRow = typeof fields.$inferSelect;

export interface NeutralityReport {
  /** true = no role gains anything it could not see before; the conversion may proceed. */
  neutral: boolean;
  /**
   * What a Members chip exposes: the linked row's title (the person's name) and number. Nothing else.
   * A chip is attached ONLY for a viewer who can read the Members database (RecordsService.attachLinks);
   * anyone else gets no chip, not a partial one.
   */
  chip_exposes: string[];
  roles: Array<{
    role: string;
    user_id: string;
    can_read_members_database: boolean;
    sees_chips_after: boolean;
    gains: string[];
  }>;
  /** Present only when `neutral` is false: which role would gain what. */
  refusal?: string;
}

@Injectable()
export class FieldConversionService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly membersDb: MembersDbService,
    private readonly fieldsService: FieldsService,
    private readonly relationsService: RelationsService,
    private readonly access: AccessService,
    private readonly databasesService: DatabasesService,
    private readonly recordsService: RecordsService,
  ) {}

  // ── shared helpers ──────────────────────────────────────────────────────

  private async membersDatabase(workspaceId: string) {
    const members = await this.membersDb.getMembersDatabase(workspaceId);
    if (!members) throw new UnprocessableEntityException('This workspace has no Members database yet, so there is nothing to convert to');
    return members;
  }

  private async userIdFieldId(membersDatabaseId: string): Promise<string> {
    const f = await this.db.query.fields.findFirst({
      where: and(eq(fields.databaseId, membersDatabaseId), eq(fields.apiName, 'user_id'), isNull(fields.deletedAt)),
    });
    if (!f) throw new UnprocessableEntityException('The Members database has no User ID column; run the Members backfill first');
    return f.id;
  }

  /** member record id by user id (exact), including tombstoned (inactive) rows. */
  private async memberRowsByUserId(membersDatabaseId: string, userIdField: string, userIds: string[]) {
    const out = new Map<string, { id: string; title: string }>();
    if (userIds.length === 0) return out;
    for (let i = 0; i < userIds.length; i += CHUNK) {
      const slice = userIds.slice(i, i + CHUNK);
      const rows = await this.db
        .select({ id: records.id, title: records.title, uid: sql<string>`${records.values}->>${userIdField}` })
        .from(records)
        .where(and(eq(records.databaseId, membersDatabaseId), isNull(records.deletedAt), inArray(sql`${records.values}->>${userIdField}`, slice)));
      for (const r of rows) out.set(r.uid, { id: r.id, title: r.title });
    }
    return out;
  }

  /** Every live record's value for one field. */
  private async fieldValues(databaseId: string, fieldId: string) {
    return this.db
      .select({ id: records.id, value: sql<unknown>`${records.values}->${fieldId}` })
      .from(records)
      .where(and(eq(records.databaseId, databaseId), isNull(records.deletedAt)));
  }

  private userIdsOf(value: unknown): string[] {
    if (typeof value === 'string' && value.trim()) return [value];
    if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
    return [];
  }

  private async hideInMembersViews(membersDatabaseId: string, fieldId: string) {
    const dbViews = await this.db.query.views.findMany({ where: eq(views.databaseId, membersDatabaseId) });
    for (const view of dbViews) {
      const config = (view.config ?? {}) as { hidden_field_ids?: string[] };
      const hidden = config.hidden_field_ids ?? [];
      if (hidden.includes(fieldId)) continue;
      await this.db.update(views).set({ config: { ...config, hidden_field_ids: [...hidden, fieldId] } }).where(eq(views.id, view.id));
    }
  }

  /**
   * The per-role permission-neutrality proof (Otto's ruling on #597): no role may gain anything it
   * could not see before. Computed from AccessService, the SAME gate `attachLinks` applies when it
   * decides whether to attach a chip, and proven end to end per role in
   * test/members-field-conversion.test.ts. admin and member read the whole workspace already; only a
   * GUEST can differ, so each active guest with any reach into the source database is evaluated.
   */
  private async neutrality(workspaceId: string, source: { id: string; spaceId: string }, members: { id: string; spaceId: string }): Promise<NeutralityReport> {
    const guests = await this.db.query.memberships.findMany({
      where: and(eq(memberships_.workspaceId, workspaceId), eq(memberships_.role, 'guest'), eq(memberships_.status, 'active')),
    });
    const roles: NeutralityReport['roles'] = [];
    for (const guest of guests) {
      const reachesSource = (await this.access.effectiveForDatabase(guest, source)) !== null || (await this.access.visibleRecordIds(guest, source)) !== null;
      if (!reachesSource) continue;
      const canReadMembers = (await this.access.effectiveForDatabase(guest, members)) !== null;
      const recordScoped = !canReadMembers && ((await this.access.visibleRecordIds(guest, members))?.ids.size ?? 0) > 0;
      const seesChips = canReadMembers || recordScoped;
      // A chip shows the Members row's title (the name). A guest who can read the Members database (or some of its
      // rows) could ALREADY read that name there, so a chip adds nothing; a guest who cannot gets no chip.
      const gains: string[] = [];
      roles.push({ role: 'guest', user_id: guest.userId, can_read_members_database: canReadMembers || recordScoped, sees_chips_after: seesChips, gains });
    }
    const gaining = roles.filter((r) => r.gains.length > 0);
    return {
      neutral: gaining.length === 0,
      chip_exposes: ['title (the person\'s name)', 'number'],
      roles,
      ...(gaining.length ? { refusal: gaining.map((r) => `guest ${r.user_id} would gain: ${r.gains.join(', ')}`).join('; ') } : {}),
    };
  }

  /**
   * The check that cannot be argued with: AFTER the conversion is applied, read the source database the way each
   * guest who cannot read Members would (the real detail and record-list paths, not a model of them) and look for
   * anything about the Members side. The first version of this feature predicted "no gains" from AccessService
   * alone and a test then showed such a guest still read the far database's name off the relation field, so
   * a prediction is not accepted as proof. A leak rolls the conversion back and names the guest.
   */
  private async probeBlindGuests(
    workspaceId: string,
    source: { id: string; spaceId: string },
    members: { id: string; name: string; spaceId: string },
    needles: string[],
  ): Promise<Array<{ user_id: string; leaks: string[] }>> {
    const guests = await this.db.query.memberships.findMany({
      where: and(eq(memberships_.workspaceId, workspaceId), eq(memberships_.role, 'guest'), eq(memberships_.status, 'active')),
    });
    const found: Array<{ user_id: string; leaks: string[] }> = [];
    for (const guest of guests) {
      const reachesSource = (await this.access.effectiveForDatabase(guest, source)) !== null || (await this.access.visibleRecordIds(guest, source)) !== null;
      if (!reachesSource) continue;
      const readsMembers = (await this.access.effectiveForDatabase(guest, members)) !== null || ((await this.access.visibleRecordIds(guest, members))?.ids.size ?? 0) > 0;
      if (readsMembers) continue; // may legitimately see chips; the per-role test pins what a chip carries
      const body =
        JSON.stringify(await this.databasesService.get(guest, source.id)) +
        JSON.stringify((await this.recordsService.list(source.id, { limit: 200 }, guest)).data);
      const leaks = [...needles, `"target_database_name":"${members.name}"`].filter((n) => n && body.includes(n));
      if (leaks.length) found.push({ user_id: guest.userId, leaks: leaks.map((l) => (l.length > 40 ? `${l.slice(0, 37)}...` : l)) });
    }
    return found;
  }

  // ── user field -> relation to Members ───────────────────────────────────

  async toMembersRelation(membership: Membership, actorId: string, databaseId: string, fieldId: string, dryRun: boolean) {
    const field = await this.fieldsService.getField(databaseId, fieldId);
    if (field.type !== 'user' || field.isSystem) {
      throw new UnprocessableEntityException(`Only a user field can be converted to a Members relation (this is "${field.type}")`);
    }
    const cfg = (field.config ?? {}) as Record<string, unknown>;
    if (cfg[MARK]) {
      throw new ConflictException('This field was already converted: it is the retained original of a Members relation. Convert the relation back first if you want to redo it');
    }
    const source = await this.db.query.databases.findFirst({ where: and(eq(databases.id, databaseId), eq(databases.workspaceId, membership.workspaceId), isNull(databases.deletedAt)) });
    if (!source) throw new NotFoundException('Database not found');
    const members = await this.membersDatabase(membership.workspaceId);
    if (members.id === source.id) throw new UnprocessableEntityException('The Members database cannot be converted into a relation to itself');
    const multi = cfg['multi'] === true;
    const cardinality = multi ? 'many_to_many' : 'one_to_many';
    const baseName = field.displayName;
    const inverseName = `${source.name} / ${baseName}`;

    const neutrality = await this.neutrality(membership.workspaceId, source, members);
    if (!neutrality.neutral) {
      throw new UnprocessableEntityException(`This conversion is not permission-neutral: ${neutrality.refusal}`);
    }

    const userIdField = await this.userIdFieldId(members.id);
    const values = await this.fieldValues(databaseId, fieldId);
    const wantedIds = [...new Set(values.flatMap((r) => this.userIdsOf(r.value)))];
    const resolved = await this.memberRowsByUserId(members.id, userIdField, wantedIds);

    let withValue = 0;
    let linkable = 0;
    const parked: Array<{ record_id: string; user_ids: string[] }> = [];
    const links: Array<{ from: string; to: string }> = [];
    for (const r of values) {
      const ids = this.userIdsOf(r.value);
      if (ids.length === 0) continue;
      withValue += 1;
      const missing = ids.filter((id) => !resolved.has(id));
      if (missing.length) parked.push({ record_id: r.id, user_ids: missing });
      for (const id of ids) {
        const row = resolved.get(id);
        if (row) links.push({ from: r.id, to: row.id });
      }
      if (ids.some((id) => resolved.has(id))) linkable += 1;
    }

    const plan = {
      dry_run: dryRun,
      field: { id: field.id, name: baseName, api_name: field.apiName, multi },
      members_database_id: members.id,
      cardinality,
      after: {
        retained_field_name: `${baseName} (user)`,
        relation_field_name: baseName,
        inverse_field_name: inverseName,
        inverse_field_hidden_by_default: true,
        note: 'The retained field keeps its api_name, so saved views, automations and API clients keep working on it until you repoint them; the new relation field gets a NEW api_name.',
      },
      counts: {
        records_with_value: withValue,
        records_that_will_link: linkable,
        links_to_write: links.length,
        records_with_unresolvable_values: parked.length,
      },
      parked: {
        meaning: 'A user id with no Members row cannot be linked. Nothing is dropped: the value stays on the retained field.',
        sample: parked.slice(0, SAMPLE),
        how_to_list_them_afterwards: `filter the relation field "is_empty" AND the retained field "not_empty"`,
      },
      permission_neutrality: {
        ...neutrality,
        verification: 'Predicted here from AccessService. When you apply, every guest who cannot read Members is probed through the real detail and record-list paths AFTER the change; any leak rolls the conversion back and names the guest.',
      },
    };
    if (dryRun) return plan;

    // ── apply ──
    // Former members referenced by this field get a Members row (existing reconcile), so they link instead of parking.
    await this.membersDb.reconcileAssignedUsers(membership.workspaceId);
    const fresh = await this.memberRowsByUserId(members.id, userIdField, wantedIds);

    await this.fieldsService.update(databaseId, fieldId, { display_name: `${baseName} (user)` });
    let relationId: string | null = null;
    try {
      const created = (await this.relationsService.create(membership, {
        database_a_id: databaseId,
        database_b_id: members.id,
        cardinality,
        field_a_name: baseName,
        field_b_name: inverseName,
      })) as { id: string; field_a: { id: string; api_name?: string; apiName?: string }; field_b: { id: string } };
      relationId = created.id;
      await this.fieldsService.update(members.id, created.field_b.id, { config: { entity_hidden: true } });
      await this.hideInMembersViews(members.id, created.field_b.id);

      const finalLinks: Array<{ relationId: string; fromRecordId: string; toRecordId: string }> = [];
      const stillParked: Array<{ record_id: string; user_ids: string[] }> = [];
      for (const r of values) {
        const ids = this.userIdsOf(r.value);
        const unresolved = ids.filter((id) => !fresh.has(id));
        if (unresolved.length) stillParked.push({ record_id: r.id, user_ids: unresolved });
        for (const id of ids) {
          const row = fresh.get(id);
          if (row) finalLinks.push({ relationId: created.id, fromRecordId: r.id, toRecordId: row.id });
        }
      }
      await this.db.transaction(async (tx) => {
        for (let i = 0; i < finalLinks.length; i += CHUNK) {
          await tx.insert(recordLinks).values(finalLinks.slice(i, i + CHUNK)).onConflictDoNothing();
        }
      });
      await this.fieldsService.update(databaseId, fieldId, { config: { [MARK]: created.id } });
      const linkedMemberIds = [...new Set(finalLinks.map((l) => l.toRecordId))];
      const linkedNames = [...fresh.values()].map((m) => m.title);
      const leaked = await this.probeBlindGuests(membership.workspaceId, source, members, [members.id, created.field_b.id, ...linkedMemberIds, ...linkedNames]);
      if (leaked.length) {
        throw new UnprocessableEntityException(
          `Rolled back: this conversion is not permission-neutral. ${leaked.map((l) => `guest ${l.user_id} (no access to Members) would gain: ${l.leaks.join(', ')}`).join('; ')}`,
        );
      }
      return {
        ...plan,
        dry_run: false,
        applied: {
          relation_id: created.id,
          relation_field_id: created.field_a.id,
          inverse_field_id: created.field_b.id,
          retained_field_id: field.id,
          links_written: finalLinks.length,
          records_parked: stillParked.length,
          parked_sample: stillParked.slice(0, SAMPLE),
        },
      };
    } catch (err) {
      // Compensate: leave the workspace as it was found, never half-converted.
      if (relationId) await this.relationsService.remove(membership.workspaceId, relationId).catch(() => undefined);
      await this.fieldsService.update(databaseId, fieldId, { display_name: baseName }).catch(() => undefined);
      throw err;
    }
  }

  // ── relation to Members -> user field ───────────────────────────────────

  async toUserField(membership: Membership, actorId: string, databaseId: string, fieldId: string, dryRun: boolean, confirmDependents: boolean) {
    const field = await this.fieldsService.getField(databaseId, fieldId);
    if (field.type !== 'relation') throw new UnprocessableEntityException(`Only a relation field can be converted back to a user field (this is "${field.type}")`);
    const relCfg = field.config as { relation_id: string; side: 'a' | 'b' };
    const relation = await this.db.query.relations.findFirst({ where: eq(relations.id, relCfg.relation_id) });
    if (!relation) throw new NotFoundException('Relation not found');
    const members = await this.membersDatabase(membership.workspaceId);
    const targetDbId = relCfg.side === 'a' ? relation.databaseBId : relation.databaseAId;
    if (targetDbId !== members.id) throw new UnprocessableEntityException('This relation does not point at the Members database');
    if (relCfg.side !== 'a') throw new UnprocessableEntityException('Convert from the field on the other database; this is the Members side of the relation');
    const multi = relation.cardinality === 'many_to_many';
    const source = await this.db.query.databases.findFirst({ where: eq(databases.id, databaseId) });
    if (!source) throw new NotFoundException('Database not found');

    // The retained original, if this relation was made by a conversion.
    const retained = await this.db.query.fields.findFirst({
      where: and(eq(fields.databaseId, databaseId), eq(fields.type, 'user'), isNull(fields.deletedAt), sql`${fields.config}->>${MARK} = ${relation.id}`),
    });
    const baseName = retained ? retained.displayName.replace(/ \(user\)$/, '') : field.displayName;

    // Dependents that removing the relation takes with it (lookups/rollups through it, soft-deleted).
    const dependents = (
      await this.db.query.fields.findMany({ where: and(inArray(fields.type, ['lookup', 'rollup']), isNull(fields.deletedAt)) })
    ).filter((f) => {
      const c = f.config as { relation_field_id?: string };
      return c.relation_field_id === relation.fieldAId || c.relation_field_id === relation.fieldBId;
    });

    const userIdField = await this.userIdFieldId(members.id);
    const linkRows = await this.db.select().from(recordLinks).where(eq(recordLinks.relationId, relation.id));
    const memberIds = [...new Set(linkRows.map((l) => l.toRecordId))];
    const memberRows = memberIds.length
      ? await this.db
          .select({ id: records.id, title: records.title, uid: sql<string | null>`${records.values}->>${userIdField}` })
          .from(records)
          .where(inArray(records.id, memberIds))
      : [];
    const memberById = new Map(memberRows.map((m) => [m.id, m]));
    const perRecord = new Map<string, { userIds: string[]; unlinked: string[] }>();
    for (const l of linkRows) {
      const m = memberById.get(l.toRecordId);
      const entry = perRecord.get(l.fromRecordId) ?? { userIds: [], unlinked: [] };
      if (m?.uid) entry.userIds.push(m.uid);
      else entry.unlinked.push(m?.title ?? l.toRecordId);
      perRecord.set(l.fromRecordId, entry);
    }
    const parked = [...perRecord.entries()].filter(([, v]) => v.unlinked.length > 0);
    // The RELATION is the source of truth after a conversion, for every person who HAS a Members row. So a record
    // whose relation is empty ends with an EMPTY user field: the retained field's old value for that person is stale
    // (they were unassigned on the relation). What is NOT stale is an id that never resolved to a Members row: that
    // value was parked, not dropped, and it stays (ADR-0012: never silently dropped). Per record the end state is
    // therefore  linked people  +  parked unresolved ids.
    const retainedIds = new Map<string, string[]>();
    if (retained) {
      for (const r of await this.fieldValues(databaseId, retained.id)) {
        const ids = this.userIdsOf(r.value);
        if (ids.length) retainedIds.set(r.id, ids);
      }
    }
    const resolvable = await this.memberRowsByUserId(members.id, userIdField, [...new Set([...retainedIds.values()].flat())]);
    const finalValue = new Map<string, string | string[] | null>();
    for (const id of new Set([...perRecord.keys(), ...retainedIds.keys()])) {
      const linked = perRecord.get(id)?.userIds ?? [];
      const keptParked = (retainedIds.get(id) ?? []).filter((u) => !resolvable.has(u));
      const combined = [...new Set([...linked, ...keptParked])];
      finalValue.set(id, combined.length === 0 ? null : multi ? combined : combined[0]!);
    }
    const toWrite = [...finalValue.entries()].filter(([, v]) => v !== null) as Array<[string, string | string[]]>;
    const toClear = [...finalValue.entries()].filter(([id, v]) => v === null && retainedIds.has(id)).map(([id]) => id);

    // Neutrality of the REVERSE: a user field exposes the raw user id. Restoring a field this feature converted
    // returns to what each role saw before the forward conversion, so it is a restore; any other relation is judged
    // role by role.
    const gains: Array<{ user_id: string; gains: string[] }> = [];
    if (!retained) {
      const guests = await this.db.query.memberships.findMany({
        where: and(eq(memberships_.workspaceId, membership.workspaceId), eq(memberships_.role, 'guest'), eq(memberships_.status, 'active')),
      });
      for (const g of guests) {
        const reachesSource = (await this.access.effectiveForDatabase(g, source)) !== null || (await this.access.visibleRecordIds(g, source)) !== null;
        const readsMembers = (await this.access.effectiveForDatabase(g, members)) !== null;
        if (reachesSource && !readsMembers) gains.push({ user_id: g.userId, gains: ['the user id of every person assigned in this field'] });
      }
    }

    const plan = {
      dry_run: dryRun,
      field: { id: field.id, name: field.displayName, api_name: field.apiName },
      cardinality: relation.cardinality,
      mode: retained ? 'restore the retained user field' : 'create a new user field',
      after: {
        user_field_name: baseName,
        inverse_field_removed: true,
        parked_text_field_name: parked.length ? `${baseName} (unlinked members)` : null,
      },
      counts: {
        records_with_links: perRecord.size,
        links: linkRows.length,
        records_with_unlinkable_members: parked.length,
        /** Records that hold a value on the retained field for someone who is no longer on the relation: their user field ends EMPTY. */
        records_cleared: toClear.length,
      },
      parked: {
        meaning: 'A Members row with no user id (an invited person, an erased member) has no user to point at. Nothing is dropped: their names go into a text field on the record.',
        sample: parked.slice(0, SAMPLE).map(([record_id, v]) => ({ record_id, member_names: v.unlinked })),
      },
      dependents_removed_with_the_relation: dependents.map((d) => ({ id: d.id, name: d.displayName, type: d.type, database_id: d.databaseId })),
      permission_neutrality: {
        neutral: gains.length === 0,
        roles: gains.map((g) => ({ role: 'guest', user_id: g.user_id, gains: g.gains })),
        ...(gains.length ? { refusal: gains.map((g) => `guest ${g.user_id} would gain: ${g.gains.join(', ')}`).join('; ') } : {}),
      },
    };
    if (dryRun) return plan;
    if (gains.length) throw new UnprocessableEntityException(`This conversion is not permission-neutral: ${plan.permission_neutrality.refusal}`);
    if (dependents.length && !confirmDependents) {
      throw new UnprocessableEntityException(`Removing the relation also removes ${dependents.length} lookup/rollup field(s) built on it (${dependents.map((d) => d.displayName).join(', ')}). Pass confirm_dependents: true to go ahead`);
    }

    // ── apply ──
    const target: FieldRow =
      retained ??
      (await this.fieldsService.create(databaseId, { display_name: `${baseName} (user)`, type: 'user', config: { multi } })) as FieldRow;
    // Write the user ids back from the relation (the relation is the source of truth now).
    for (const [recordId, value] of toWrite) {
      await this.db
        .update(records)
        .set({ values: sql`jsonb_set(${records.values}, ${`{${target.id}}`}::text[], ${JSON.stringify(value)}::jsonb, true)` })
        .where(eq(records.id, recordId));
    }
    // A record whose relation is empty must not keep the retained field's STALE value: clear it.
    let cleared = 0;
    for (let i = 0; i < toClear.length; i += CHUNK) {
      const gone = await this.db
        .update(records)
        .set({ values: sql`${records.values} - ${target.id}` })
        .where(inArray(records.id, toClear.slice(i, i + CHUNK)))
        .returning({ id: records.id });
      cleared += gone.length;
    }
    let parkedFieldId: string | null = null;
    if (parked.length) {
      const text = (await this.fieldsService.create(databaseId, { display_name: `${baseName} (unlinked members)`, type: 'text' })) as FieldRow;
      parkedFieldId = text.id;
      for (const [recordId, v] of parked) {
        await this.db
          .update(records)
          .set({ values: sql`jsonb_set(${records.values}, ${`{${text.id}}`}::text[], ${JSON.stringify(v.unlinked.join(', '))}::jsonb, true)` })
          .where(eq(records.id, recordId));
      }
    }
    // Removing the relation removes the Members-side inverse field with it (RelationsService.remove deletes both
    // fields), so the undo leaves no orphan on Members.
    await this.relationsService.remove(membership.workspaceId, relation.id);
    await this.fieldsService.update(databaseId, target.id, { display_name: baseName });
    if (retained) {
      const current = ((await this.fieldsService.getField(databaseId, target.id)).config ?? {}) as Record<string, unknown>;
      delete current[MARK];
      await this.db.update(fields).set({ config: current }).where(eq(fields.id, target.id));
    }
    return {
      ...plan,
      dry_run: false,
      applied: { user_field_id: target.id, parked_text_field_id: parkedFieldId, records_written: toWrite.length, records_cleared: cleared },
    };
  }
}

