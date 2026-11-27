import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { and, desc, eq, isNull, inArray, sql } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { fields, linearStatusPushes, recordFieldChanges, records, selectOptions } from '../db/schema';
import { env } from '../config/env';
import { MAX_ATTEMPTS, nextAttemptDelayMs } from '../common/backoff-schedule';
import { logAgentOriginOutward } from '../activity/agent-origin-log';
import { LinearService } from './linear.service';
import { ownerOfDatabase, statusWriteBack, teamOwnership } from './linear-ownership';
import { redactError } from './slack-subscriptions.service';

/**
 * Ticket #1390 - a read of ONE issue: its current state and its team's workflow states (a state belongs to a team, so the issue's own
 * team is where its target is looked up, with no team id to carry or guess). Shape from Linear's published schema, not yet run
 * against the live API: `issue(id)`, `Issue.state`, `Issue.team.states` (a connection, `first` at most 250).
 */
export const ISSUE_STATUS_QUERY = `query IssueStatusForWriteBack($id: String!) { issue(id: $id) { id state { id name } team { id key states(first: 250) { nodes { id name type } pageInfo { hasNextPage endCursor } } } } }`;

/** The one Linear mutation this service ever sends, with `input: { stateId }` and nothing else: no title, assignee or other field is ever written. */
export const ISSUE_STATUS_UPDATE_MUTATION = `mutation IssueStatusUpdate($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { id state { id name } } } }`;

/** A send stuck in `sending` this long was cut off by a crash; it is put back in the queue. */
const SENDING_TIMEOUT_MINUTES = 10;
/** Rows sent per workspace per tick (each costs two requests to Linear). */
const BATCH = 20;

/**
 * Ticket #1390 - while a Linear team is StoryOS-owned (ticket #1370) and an admin switched it on for that team, a status changed in
 * StoryOS is written to the matching Linear issue. STATUS ONLY: nothing else of the record is ever sent, and no title or body.
 *
 * How it works, and why it is not a hook or a history reader:
 *  - A polled outbox, like the comment push beside it (`linear-write-back.service.ts`), because a callback from records into
 *    Linear would be a module cycle and an outbox gives retry and a visible failure state for free. Latency is one 60 s tick.
 *  - The trigger is STATE, not history: a record of the team whose State differs from what Linear was last told (or, with no row yet,
 *    from the `linear_status` the importer last read). Field history is off on a plan with no retention and pruned on the others, so
 *    a trigger built on it would silently never fire there. Comparing state also coalesces for free: ten changes are one row aimed at
 *    the latest status, and Todo -> Done -> Todo queues nothing.
 *    Consequence, documented in the guide: it compares, it does not ask what changed, so a title-only edit of a record whose status
 *    already differed from Linear's pushes that status. Narrowing it needs field history, which a plan can have off.
 *  - ONE row per record. `generation` is the monotonic change id: it goes up when the target changes, a send claims one generation,
 *    and its outcome is stored only if that generation is still current, so a slow send never buries a newer change.
 *  - Exactly once: every attempt READS Linear first and sends nothing when the issue already has the status, so a retry after a lost
 *    response (Linear applied it, the answer never came) does not apply it twice, and neither does a sync that read our own write.
 *  - A StoryOS status with no Linear state of that exact name is `unmapped`: reported, never guessed, not retried on a timer.
 *  - The guard is one function, `mayWrite`, asked at enqueue AND again immediately before the call: the queue is never trusted for
 *    ownership. A team Linear owns never passes; handing a team back cancels what was queued.
 *  - Writes use the workspace's stored Linear key, server-side, never a member's. An agent that changed the status is recorded on the row
 *    and logged as `outward.linear_status` with its run.
 *
 * The echo: a StoryOS-owned team is never written by the Linear sync (ticket #1370), so our write cannot come back as a foreign change;
 * and the sync writing a Linear-owned team creates no row, because that team never passes the guard.
 */
@Injectable()
export class LinearStatusWriteBackService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LinearStatusWriteBackService.name);
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly linear: LinearService,
  ) {}

  onModuleInit() {
    if (env().NODE_ENV !== 'test') this.timer = setInterval(() => void this.tick(), 60_000);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** One pass: queue what changed, then send what is due. Public so tests can call it. */
  async tick(now = new Date()): Promise<void> {
    const found = (await this.db.execute(sql`
      SELECT id FROM workspaces
       WHERE settings->'linear'->'status_write_back' IS NOT NULL
          OR EXISTS (SELECT 1 FROM linear_status_pushes p WHERE p.workspace_id = workspaces.id AND p.status IN ('pending', 'sending'))`)) as unknown as { rows?: Array<{ id: string }> };
    for (const { id } of found.rows ?? []) {
      try {
        await this.enqueueEligible(id, now);
        await this.sendDue(id, now);
      } catch (error) {
        this.logger.warn(`linear status write-back for ${id} failed: ${redactError(String(error))}`);
      }
    }
  }

  /**
   * Queue the records of every team that passes the guard whose State differs from what Linear holds, among those changed since the
   * switch was thrown (never a replay of what was edited before). Returns how many rows were queued or re-aimed.
   */
  async enqueueEligible(workspaceId: string, now = new Date()): Promise<number> {
    const settings = await this.linear.readLinearSettings(workspaceId);
    let queued = 0;
    for (const key of Object.keys(settings.status_write_back ?? {})) {
      const guard = statusWriteBack(settings, key);
      if (!guard.allowed) continue;
      const issuesDb = await this.linear.issuesDatabaseOfTeam(workspaceId, settings, key);
      if (!issuesDb) continue;
      const own = teamOwnership(settings, key);
      const switchedOnAt = settings.status_write_back?.[key]?.enabled_at;
      const since = [switchedOnAt, own.cut_over_at].filter((v): v is string => typeof v === 'string').sort().at(-1) ?? now.toISOString();
      const f = await this.fieldIds(issuesDb.id);
      if (!f.state || !f.linearId) continue;
      const baseline = f.linearStatus ? sql`r.values->>(${f.linearStatus}::text)` : sql`NULL`;
      const found = (await this.db.execute(sql`
        SELECT r.id AS record_id, r.values->>(${f.linearId}::text) AS linear_id, so.label AS label
          FROM records r
          JOIN select_options so ON so.field_id = ${f.state}::uuid AND so.id::text = r.values->>(${f.state}::text)
          LEFT JOIN linear_status_pushes p ON p.record_id = r.id
         WHERE r.database_id = ${issuesDb.id}::uuid AND r.deleted_at IS NULL AND r.updated_at > ${since}::timestamptz
           AND coalesce(r.values->>(${f.linearId}::text), '') <> ''
           AND ((p.record_id IS NULL AND so.label IS DISTINCT FROM ${baseline}) OR (p.record_id IS NOT NULL AND p.target_label IS DISTINCT FROM so.label))
         ORDER BY r.updated_at
         LIMIT 500`)) as unknown as { rows?: Array<{ record_id: string; linear_id: string; label: string }> };
      const wanted = found.rows ?? [];
      if (wanted.length === 0) continue;
      const provenance = await this.provenance(
        wanted.map((w) => w.record_id),
        f.state,
      );
      for (const w of wanted) {
        const who = provenance.get(w.record_id);
        const res = (await this.db.execute(sql`
          INSERT INTO linear_status_pushes (record_id, workspace_id, team_key, linear_issue_id, target_label, next_attempt_at, change_source, change_agent_name)
          VALUES (${w.record_id}::uuid, ${workspaceId}::uuid, ${key}, ${w.linear_id}, ${w.label}, ${now.toISOString()}::timestamptz, ${who?.source ?? null}, ${who?.agentName ?? null})
          ON CONFLICT (record_id) DO UPDATE SET
            team_key = excluded.team_key, linear_issue_id = excluded.linear_issue_id, target_label = excluded.target_label,
            generation = linear_status_pushes.generation + 1, status = 'pending', attempts = 0, next_attempt_at = excluded.next_attempt_at,
            last_error = NULL, change_source = excluded.change_source, change_agent_name = excluded.change_agent_name, updated_at = now()
          WHERE linear_status_pushes.target_label IS DISTINCT FROM excluded.target_label
          RETURNING record_id`)) as unknown as { rows?: unknown[] };
        queued += res.rows?.length ?? 0;
      }
    }
    return queued;
  }

  private async sendDue(workspaceId: string, now: Date): Promise<void> {
    await this.db.execute(sql`
      UPDATE linear_status_pushes SET status = 'pending'
       WHERE workspace_id = ${workspaceId} AND status = 'sending'
         AND updated_at < ${new Date(now.getTime() - SENDING_TIMEOUT_MINUTES * 60_000).toISOString()}::timestamptz`);
    // Claim a batch atomically (safe with several API instances): the winner flips them to 'sending'.
    const claimed = (await this.db.execute(sql`
      UPDATE linear_status_pushes SET status = 'sending', attempts = attempts + 1, updated_at = now()
       WHERE record_id IN (
         SELECT record_id FROM linear_status_pushes
          WHERE workspace_id = ${workspaceId} AND status = 'pending' AND next_attempt_at <= ${now.toISOString()}::timestamptz
          ORDER BY next_attempt_at LIMIT ${BATCH} FOR UPDATE SKIP LOCKED)
      RETURNING record_id, attempts, generation`)) as unknown as { rows?: Array<{ record_id: string; attempts: number; generation: number }> };
    for (const row of claimed.rows ?? []) await this.pushOne(workspaceId, row.record_id, row.attempts, row.generation, now);
  }

  /** Store an outcome for the generation this send claimed, and only if it is still the current one (a newer change keeps its own row state). */
  private async settle(recordId: string, generation: number, set: Partial<typeof linearStatusPushes.$inferInsert>): Promise<void> {
    await this.db
      .update(linearStatusPushes)
      .set({ ...set, updatedAt: new Date() })
      .where(and(eq(linearStatusPushes.recordId, recordId), eq(linearStatusPushes.generation, generation)));
  }

  /**
   * THE guard, asked before anything leaves: the record's database is a Linear team's mirror, StoryOS owns that team, and an admin
   * switched status write-back on for it. Read fresh from the settings every time. Returns the reason when not, or the team and the
   * record's facts when so.
   *
   * Not atomic with the send, and it cannot be: the guard is read, then Linear is called, with nothing holding the settings still in
   * between. A hand-back or switch-off that lands in that window (milliseconds, around two requests) can still let ONE write through that
   * was allowed when it was checked. It is bounded to the rows of that batch and the next tick cancels the rest.
   */
  private async mayWrite(workspaceId: string, recordId: string): Promise<{ ok: false; reason: string } | { ok: true; teamKey: string; linearId: string; label: string }> {
    const record = await this.db.query.records.findFirst({ where: eq(records.id, recordId), columns: { databaseId: true, values: true, deletedAt: true } });
    if (!record || record.deletedAt) return { ok: false, reason: 'The record was deleted before its status was sent.' };
    const owner = await ownerOfDatabase(this.db, workspaceId, record.databaseId);
    if (!owner) return { ok: false, reason: 'This record is not part of a Linear team mirror.' };
    if (owner.owner !== 'storyos') return { ok: false, reason: `${owner.team_key} is owned by Linear: StoryOS never writes to it.` };
    const settings = await this.linear.readLinearSettings(workspaceId);
    if (!statusWriteBack(settings, owner.team_key).allowed) return { ok: false, reason: `Status write-back is not on for ${owner.team_key}, or its ownership state is not exactly StoryOS.` };
    const f = await this.fieldIds(record.databaseId);
    const values = (record.values ?? {}) as Record<string, unknown>;
    const linearId = f.linearId ? values[f.linearId] : null;
    if (typeof linearId !== 'string' || linearId === '') return { ok: false, reason: 'The record has no Linear issue id.' };
    const optionId = f.state ? values[f.state] : null;
    const option = typeof optionId === 'string' && f.state ? await this.db.query.selectOptions.findFirst({ where: and(eq(selectOptions.id, optionId), eq(selectOptions.fieldId, f.state)), columns: { label: true } }) : null;
    if (!option) return { ok: false, reason: 'The record has no status to send.' };
    return { ok: true, teamKey: owner.team_key, linearId, label: option.label };
  }

  private async pushOne(workspaceId: string, recordId: string, attempts: number, generation: number, now: Date): Promise<void> {
    let apiKey: string | null = null;
    try {
      const gate = await this.mayWrite(workspaceId, recordId);
      if (!gate.ok) {
        await this.settle(recordId, generation, { status: 'cancelled', lastError: gate.reason });
        return;
      }
      const { teamKey, linearId, label } = gate;
      apiKey = await this.linear.apiKeyFor(workspaceId);
      // Every attempt reads first: the status may already be there (a retry after a lost response, a change made back by hand in Linear).
      const read = (await this.linear.fetcher(ISSUE_STATUS_QUERY, { id: linearId }, apiKey)) as {
        issue?: { id?: string; state?: { id?: string; name?: string } | null; team?: { states?: { nodes?: Array<{ id: string; name: string }>; pageInfo?: { hasNextPage?: boolean } } } | null } | null;
      };
      const issue = read.issue;
      if (!issue) throw new Error('Linear has no issue with this id');
      if (issue.state?.name === label) {
        await this.settle(recordId, generation, { status: 'sent', lastError: null, appliedLabel: label, appliedStateId: issue.state.id ?? null, appliedGeneration: generation });
        return;
      }
      const states = issue.team?.states;
      // An answer we cannot read as the complete workflow is NOT "no such state": that reading would report a status as unmapped, or guess.
      if (!states || !Array.isArray(states.nodes) || states.pageInfo?.hasNextPage !== false) throw new Error("Linear returned no complete list of this team's workflow states, so the status cannot be mapped");
      const matches = states.nodes.filter((s) => s.name === label);
      if (matches.length !== 1) {
        const why = matches.length === 0 ? `No Linear state named "${label.slice(0, 60)}" in ${teamKey}'s workflow` : `More than one Linear state named "${label.slice(0, 60)}" in ${teamKey}'s workflow`;
        await this.settle(recordId, generation, { status: 'unmapped', lastError: `${why}: not written. A status is never guessed; rename one to match, then switch write-back off and on.` });
        return;
      }
      const stateId = matches[0]!.id;
      const data = (await this.linear.fetcher(ISSUE_STATUS_UPDATE_MUTATION, { id: linearId, input: { stateId } }, apiKey)) as {
        issueUpdate?: { success?: boolean; issue?: { state?: { id?: string } | null } | null };
      };
      if (data.issueUpdate?.success !== true || data.issueUpdate.issue?.state?.id !== stateId) throw new Error('Linear did not confirm the status change');
      await this.settle(recordId, generation, { status: 'sent', lastError: null, appliedLabel: label, appliedStateId: stateId, appliedGeneration: generation });
      await this.logAgentCaused(workspaceId, recordId, label, teamKey);
    } catch (error) {
      let message = redactError(error instanceof Error ? error.message : String(error));
      if (apiKey) message = message.split(apiKey).join('[redacted]');
      const delay = nextAttemptDelayMs(attempts);
      if (delay !== null) {
        await this.settle(recordId, generation, { status: 'pending', lastError: message, nextAttemptAt: new Date(now.getTime() + delay) });
        return;
      }
      // Out of attempts: a dead letter. It stays visible (Linear settings, Preview, sync summary) until an admin switches the team's write-back off and on, or the status changes again.
      await this.settle(recordId, generation, { status: 'failed', lastError: `Gave up after ${MAX_ATTEMPTS} attempts: ${message}` });
    }
  }

  /** The history row behind each record's current status, for who changed it (null when the plan keeps no history). */
  private async provenance(recordIds: string[], stateField: string): Promise<Map<string, { source: string; agentName: string | null }>> {
    const out = new Map<string, { source: string; agentName: string | null }>();
    if (recordIds.length === 0) return out;
    const changes = await this.db
      .select({ recordId: recordFieldChanges.recordId, source: recordFieldChanges.source, agentName: recordFieldChanges.agentName })
      .from(recordFieldChanges)
      .where(and(inArray(recordFieldChanges.recordId, recordIds), eq(recordFieldChanges.fieldId, stateField)))
      .orderBy(desc(recordFieldChanges.createdAt));
    for (const c of changes) if (!out.has(c.recordId)) out.set(c.recordId, { source: c.source, agentName: c.agentName });
    return out;
  }

  /** An agent's run credential behind the status is logged like every other outward write an agent caused (the destination is the admin's own Linear). Never fails the send. */
  private async logAgentCaused(workspaceId: string, recordId: string, label: string, teamKey: string): Promise<void> {
    try {
      const row = await this.db.query.linearStatusPushes.findFirst({ where: eq(linearStatusPushes.recordId, recordId), columns: { changeSource: true } });
      if (row?.changeSource !== 'agent') return;
      const issue = await this.db.query.records.findFirst({ where: eq(records.id, recordId), columns: { databaseId: true } });
      const f = issue ? await this.fieldIds(issue.databaseId) : null;
      if (!f?.state) return;
      const change = await this.db.query.recordFieldChanges.findFirst({ where: and(eq(recordFieldChanges.recordId, recordId), eq(recordFieldChanges.fieldId, f.state)), orderBy: [desc(recordFieldChanges.createdAt)] });
      if (!change || change.source !== 'agent' || !change.agentId) return;
      await logAgentOriginOutward(this.db, {
        workspaceId, recordId, recordTitle: null, channel: 'linear_status', summary: `Set the status "${label.slice(0, 60)}" on the Linear issue of team ${teamKey}`,
        origin: { agentId: change.agentId, agentName: change.agentName, runId: change.runId ?? null, runnerId: change.runnerId ?? '', runnerName: change.runnerName ?? null },
      });
    } catch (error) {
      this.logger.warn(`linear status write-back: could not log the agent origin: ${redactError(String(error))}`);
    }
  }

  private async fieldIds(databaseId: string): Promise<{ state: string | null; linearId: string | null; linearStatus: string | null }> {
    const rows = await this.db.query.fields.findMany({ where: and(eq(fields.databaseId, databaseId), isNull(fields.deletedAt)), columns: { id: true, apiName: true } });
    const by = (api: string) => rows.find((r) => r.apiName === api)?.id ?? null;
    return { state: by('state'), linearId: by('linear_id'), linearStatus: by('linear_status') };
  }
}
