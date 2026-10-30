import { ForbiddenException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { and, count, desc, eq, gt, inArray, isNull, lte, ne, sql } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import {
  databases,
  fields,
  memberships,
  records,
  runnerAgents,
  runnerPairingCodes,
  runnerPairingFailures,
  runners,
  selectOptions,
} from '../db/schema';
import type { ChangeSource, RunnerToolInfo } from '../db/schema';
import { codedException } from '../common/coded-exception';
import { resolveAgentIdentity } from '../agents/agent-identity';
import {
  PAIRING_CODES_PER_HOUR,
  PAIRING_FAILURE_WINDOW_MS,
  PAIRING_MAX_FAILURES_GLOBAL,
  PAIRING_MAX_FAILURES_PER_IP,
  PAIRING_WINDOW_MS,
  RUNNER_HEARTBEAT_INTERVAL_SECONDS,
  RUNNER_OFFLINE_AFTER_MS,
  RUNNER_PROTOCOL_MAX,
  RUNNER_PROTOCOL_MIN,
  RUNNER_SEEN_WRITE_THROTTLE_MS,
  RUNNER_TOKEN_PREFIX,
  RUNNER_UPGRADE_COMMAND,
} from './runner.constants';
import type { RunnerPairInput, RunnerReport } from './runner.dto';
import { generatePairingCode, hashPairingCode, hashRunnerToken, mintRunnerToken, normalizePairingCode, safeEqualHex } from './runner-secrets';
import { canonicalJson, presentRunner, recordRunnerEvent } from './runner-present';
import type { RunnerRow } from './runner-present';
import type { Membership } from '../workspaces/workspace-access.guard';

export type RunnerRevokeReason = 'removed' | 'cancelled' | 'pairing_expired' | 'member_inactive' | 'erased';

const NOT_FOUND = 'Runner not found';
/** The one sentence a Runner is told when its pairing ended without Done, so it can say what to do rather than just "401". */
const PAIRING_EXPIRED_MESSAGE = 'The pairing window ended before you pressed Done in StoryOS. Run `storyos-runner pair` again.';
const PAIRING_CANCELLED_MESSAGE = 'The pairing was cancelled in StoryOS. Run `storyos-runner pair` again.';

/** The sentence of the #1091 rule, for a Runner: a guest may not hold one, and the way to get one is an admin. */
export const GUEST_RUNNER_MESSAGE = 'Guests cannot pair a Runner. Ask a workspace admin if you need access.';

/**
 * ADR-0021 §3 — registering a Runner: pairing, the runner token, heartbeat, offline, removal, and the agent→Runner assignment.
 *
 * Two audiences use this class and are kept apart by the controllers, not here: the signed-in person in the app (the
 * `workspaces/:ws/runners` routes: owner-only, so someone else's Runner id is the SAME 404 a nonexistent one gets, ADR-0018 (b)),
 * and the Runner program itself (the `runner/v1` routes: its own `mn_run_` credential, confined to those routes).
 */
@Injectable()
export class RunnersService {
  constructor(@Inject(DB) private readonly db: Db) {}

  // ---------------------------------------------------------------- pairing (the person, in the app)

  /**
   * Issues a pairing code. A new code burns the person's previous UNUSED one, so live guessable codes do not accumulate (one live
   * code per person and workspace). A guest is refused with the #1091 sentence: a Runner credential is at least as powerful as a PAT.
   */
  async issueCode(membership: Membership, userId: string, now = new Date()) {
    if (membership.role === 'guest') throw new ForbiddenException(GUEST_RUNNER_MESSAGE);
    const workspaceId = membership.workspaceId;
    const [recent] = await this.db
      .select({ issued: count() })
      .from(runnerPairingCodes)
      .where(and(eq(runnerPairingCodes.workspaceId, workspaceId), eq(runnerPairingCodes.userId, userId), gt(runnerPairingCodes.createdAt, new Date(now.getTime() - 3_600_000))));
    if ((recent?.issued ?? 0) >= PAIRING_CODES_PER_HOUR) {
      throw codedException(429, 'pairing_codes_limit', 'Too many pairing codes were requested in the last hour. Wait a little and try again.', { retry_after_seconds: 600 });
    }
    const expiresAt = new Date(now.getTime() + PAIRING_WINDOW_MS);
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = generatePairingCode();
      try {
        const row = await this.db.transaction(async (tx) => {
          await tx
            .update(runnerPairingCodes)
            .set({ cancelledAt: now })
            .where(and(eq(runnerPairingCodes.workspaceId, workspaceId), eq(runnerPairingCodes.userId, userId), isNull(runnerPairingCodes.usedAt), isNull(runnerPairingCodes.cancelledAt)));
          const [created] = await tx
            .insert(runnerPairingCodes)
            .values({ workspaceId, userId, codeHash: hashPairingCode(code), expiresAt })
            .returning();
          return created!;
        });
        return { id: row.id, code, expires_at: row.expiresAt };
      } catch (error) {
        // Two live codes colliding on the hash is a 1-in-887-million event; draw again rather than fail the person.
        if (!(error instanceof Error && /unique|duplicate/i.test(`${error.message} ${(error as { cause?: Error }).cause?.message ?? ''}`))) throw error;
      }
    }
    throw codedException(503, 'pairing_code_unavailable', 'Could not issue a pairing code. Try again.');
  }

  private async ownCode(workspaceId: string, userId: string, codeId: string) {
    // Not a uuid, not this workspace's, or someone else's: one answer, so this cannot be used to probe codes.
    const row = /^[0-9a-f-]{36}$/i.test(codeId)
      ? await this.db.query.runnerPairingCodes.findFirst({
          where: and(eq(runnerPairingCodes.id, codeId), eq(runnerPairingCodes.workspaceId, workspaceId), eq(runnerPairingCodes.userId, userId)),
        })
      : null;
    if (!row) throw new NotFoundException('Pairing code not found');
    return row;
  }

  /**
   * What the open "Add a Runner" dialog polls. `connected` means the Runner exchanged the code (a pending, or by now active, Runner
   * exists); `expired` is reported once the window has passed without Done; `cancelled` after Cancel. Never returns the code.
   */
  async codeStatus(workspaceId: string, userId: string, codeId: string, now = new Date()) {
    const code = await this.ownCode(workspaceId, userId, codeId);
    const runner = await this.db.query.runners.findFirst({ where: eq(runners.pairingCodeId, code.id) });
    let status: 'waiting' | 'connected' | 'expired' | 'cancelled';
    if (runner) {
      if (runner.status === 'revoked') status = runner.revokedReason === 'cancelled' ? 'cancelled' : 'expired';
      else if (runner.status === 'pending' && runner.pendingExpiresAt && runner.pendingExpiresAt.getTime() <= now.getTime()) status = 'expired';
      else status = 'connected';
    } else if (code.cancelledAt) status = 'cancelled';
    else status = code.expiresAt.getTime() <= now.getTime() ? 'expired' : 'waiting';
    return {
      status,
      expires_at: code.expiresAt,
      ...(runner && status === 'connected' ? { runner: { id: runner.id, name: runner.name, tools: runner.tools } } : {}),
    };
  }

  /** Cancel: burns the code AND revokes the Runner it produced if that one is still pending. An already activated Runner is left alone (Cancel after Done is a stale click). */
  async cancelCode(workspaceId: string, userId: string, codeId: string, actor: { source: ChangeSource }, now = new Date()) {
    const code = await this.ownCode(workspaceId, userId, codeId);
    await this.db.update(runnerPairingCodes).set({ cancelledAt: now }).where(and(eq(runnerPairingCodes.id, code.id), isNull(runnerPairingCodes.cancelledAt)));
    const runner = await this.db.query.runners.findFirst({ where: and(eq(runners.pairingCodeId, code.id), eq(runners.status, 'pending')) });
    if (runner) await this.revoke(runner, 'cancelled', { actorId: userId, source: actor.source }, now);
  }

  // ---------------------------------------------------------------- pairing (the Runner program)

  /** `426` for a Runner older than this server speaks, `409` for one newer than it does. Both say what to do. */
  assertProtocolSupported(protocolVersion: number): void {
    if (protocolVersion < RUNNER_PROTOCOL_MIN) {
      throw codedException(
        426,
        'runner_upgrade_required',
        `This Runner is too old for this StoryOS server. Update it with \`${RUNNER_UPGRADE_COMMAND}\` and try again.`,
        { minimum_protocol: RUNNER_PROTOCOL_MIN, maximum_protocol: RUNNER_PROTOCOL_MAX, update_command: RUNNER_UPGRADE_COMMAND },
      );
    }
    if (protocolVersion > RUNNER_PROTOCOL_MAX) {
      throw codedException(
        409,
        'server_older_than_runner',
        'This StoryOS server is older than this Runner. Install the Runner version that matches the server, or ask your admin to update the server.',
        { minimum_protocol: RUNNER_PROTOCOL_MIN, maximum_protocol: RUNNER_PROTOCOL_MAX },
      );
    }
  }

  private async assertNotLocked(ip: string, now: Date): Promise<void> {
    const since = new Date(now.getTime() - PAIRING_FAILURE_WINDOW_MS);
    const [mine] = await this.db
      .select({ n: count(), oldest: sql<Date | null>`min(${runnerPairingFailures.createdAt})` })
      .from(runnerPairingFailures)
      .where(and(eq(runnerPairingFailures.ip, ip), gt(runnerPairingFailures.createdAt, since)));
    if (mine!.n >= PAIRING_MAX_FAILURES_PER_IP) {
      const oldest = mine!.oldest ? new Date(mine!.oldest).getTime() : now.getTime();
      const retry = Math.max(1, Math.ceil((oldest + PAIRING_FAILURE_WINDOW_MS - now.getTime()) / 1000));
      throw codedException(429, 'pairing_locked', 'Too many wrong codes from this network. Wait a few minutes, then start again from StoryOS.', { retry_after_seconds: retry });
    }
    const [all] = await this.db.select({ n: count() }).from(runnerPairingFailures).where(gt(runnerPairingFailures.createdAt, since));
    if (all!.n >= PAIRING_MAX_FAILURES_GLOBAL) {
      throw codedException(429, 'pairing_busy', 'Pairing is temporarily paused because of repeated wrong codes. Try again in a few minutes.', { retry_after_seconds: 300 });
    }
  }

  private async recordFailure(ip: string): Promise<never> {
    await this.db.insert(runnerPairingFailures).values({ ip });
    // One sentence for "no such code" however it is wrong, so a guess learns nothing from the wording.
    throw codedException(422, 'invalid_code', 'That code is not valid. Check it, or start again from "Add a Runner" in StoryOS.');
  }

  /**
   * The Runner exchanges the code for its token. Single use, enforced by ONE conditional UPDATE (a second concurrent exchange of the
   * same code updates zero rows). The Runner it creates is PENDING: the token authenticates, but the Runner does nothing until the
   * person presses Done in the app (activation), and an un-activated one is revoked when the pairing window closes.
   */
  async exchange(input: RunnerPairInput, ip: string, now = new Date()) {
    this.assertProtocolSupported(input.protocol_version);
    await this.assertNotLocked(ip, now);
    const normalized = normalizePairingCode(input.code);
    if (!normalized) return this.recordFailure(ip);
    const hash = hashPairingCode(normalized);
    const code = await this.db.query.runnerPairingCodes.findFirst({ where: eq(runnerPairingCodes.codeHash, hash) });
    if (!code || !safeEqualHex(code.codeHash, hash)) return this.recordFailure(ip);

    // A real code, so these may say what is wrong with it: the caller already holds it.
    const reject = (): never => {
      if (code.cancelledAt) throw codedException(409, 'pairing_cancelled', PAIRING_CANCELLED_MESSAGE);
      if (code.usedAt) throw codedException(409, 'code_already_used', 'That code was already used. Start again from "Add a Runner" in StoryOS.');
      throw codedException(409, 'pairing_expired', PAIRING_EXPIRED_MESSAGE);
    };
    if (code.cancelledAt || code.usedAt || code.expiresAt.getTime() <= now.getTime()) {
      await this.db.insert(runnerPairingFailures).values({ ip });
      return reject();
    }
    const membership = await this.db.query.memberships.findFirst({
      where: and(eq(memberships.workspaceId, code.workspaceId), eq(memberships.userId, code.userId), eq(memberships.status, 'active')),
      columns: { role: true },
    });
    if (!membership || membership.role === 'guest') throw new ForbiddenException(GUEST_RUNNER_MESSAGE);

    const minted = mintRunnerToken();
    const created = await this.db.transaction(async (tx) => {
      const claimed = await tx
        .update(runnerPairingCodes)
        .set({ usedAt: now })
        .where(and(eq(runnerPairingCodes.id, code.id), isNull(runnerPairingCodes.usedAt), isNull(runnerPairingCodes.cancelledAt), gt(runnerPairingCodes.expiresAt, now)))
        .returning({ id: runnerPairingCodes.id });
      if (claimed.length === 0) return null;
      const [row] = await tx
        .insert(runners)
        .values({
          workspaceId: code.workspaceId,
          userId: code.userId,
          pairingCodeId: code.id,
          name: input.machine_name,
          tokenHash: minted.tokenHash,
          tokenPrefix: minted.tokenPrefix,
          status: 'pending',
          tools: input.tools as RunnerToolInfo[],
          runnerVersion: input.runner_version,
          protocolVersion: input.protocol_version,
          lastSeenAt: now,
          pendingExpiresAt: code.expiresAt,
        })
        .returning();
      await recordRunnerEvent(tx, {
        workspaceId: code.workspaceId,
        action: 'paired',
        runner: { id: row!.id, name: row!.name },
        actorId: code.userId,
        // The code was issued by the person at their keyboard; the exchange itself came from the Runner program. No source is claimed.
        source: null,
        extra: { runner_version: input.runner_version, protocol_version: input.protocol_version },
      });
      return row!;
    });
    if (!created) {
      // Lost a race for the same code (or it expired between the read and the write).
      const fresh = await this.db.query.runnerPairingCodes.findFirst({ where: eq(runnerPairingCodes.id, code.id) });
      if (fresh?.usedAt) throw codedException(409, 'code_already_used', 'That code was already used. Start again from "Add a Runner" in StoryOS.');
      throw codedException(409, 'pairing_expired', PAIRING_EXPIRED_MESSAGE);
    }
    return {
      token: minted.token,
      runner: { id: created.id, status: created.status, name: created.name },
      workspace_id: created.workspaceId,
      pending_expires_at: created.pendingExpiresAt,
      protocol: { minimum: RUNNER_PROTOCOL_MIN, maximum: RUNNER_PROTOCOL_MAX },
    };
  }

  // ---------------------------------------------------------------- the Runner's credential

  /** Throttler-side: the stable per-Runner bucket key, or null for a token that resolves to nothing (so a bogus one cannot mint buckets). */
  async identify(token: string): Promise<string | null> {
    if (!token.startsWith(RUNNER_TOKEN_PREFIX)) return null;
    const hash = hashRunnerToken(token);
    const row = await this.db.query.runners.findFirst({ columns: { id: true }, where: and(eq(runners.tokenHash, hash), ne(runners.status, 'revoked')) });
    return row ? hash : null;
  }

  /**
   * Guard-side: the Runner this token belongs to, or an error that says why not. Revoked, cancelled, expired-while-pending and
   * "its owner left the workspace" are all refused HERE, on the very next call, rather than waiting for the sweeper.
   */
  async resolveToken(token: string, now = new Date()): Promise<RunnerRow> {
    const hash = hashRunnerToken(token);
    const row = await this.db.query.runners.findFirst({ where: eq(runners.tokenHash, hash) });
    if (!row || !safeEqualHex(row.tokenHash, hash)) throw codedException(401, 'invalid_runner_token', 'Invalid Runner token. Pair this Runner again.');
    if (row.status === 'revoked') {
      const message =
        row.revokedReason === 'cancelled'
          ? PAIRING_CANCELLED_MESSAGE
          : row.revokedReason === 'pairing_expired'
            ? PAIRING_EXPIRED_MESSAGE
            : 'This Runner was removed in StoryOS. Run `storyos-runner pair` to add it again.';
      throw codedException(401, 'runner_revoked', message, { reason: row.revokedReason });
    }
    if (row.status === 'pending' && row.pendingExpiresAt && row.pendingExpiresAt.getTime() <= now.getTime()) {
      throw codedException(401, 'runner_revoked', PAIRING_EXPIRED_MESSAGE, { reason: 'pairing_expired' });
    }
    const membership = await this.db.query.memberships.findFirst({
      where: and(eq(memberships.workspaceId, row.workspaceId), eq(memberships.userId, row.userId), eq(memberships.status, 'active')),
      columns: { role: true },
    });
    if (!membership || membership.role === 'guest') {
      throw codedException(401, 'runner_owner_inactive', 'The person this Runner belongs to is no longer a member of the workspace.');
    }
    return row;
  }

  /**
   * Every heartbeat: liveness (`last_seen_at`, throttled so an idle Runner costs a write every 30 s, not one per request), the
   * facts the Runner reports (name, tools, versions) and the agents assigned to THIS Runner and nobody else's. Returns to
   * "online" by clearing the episode marker the offline notification de-duplicates on.
   */
  async heartbeat(runner: RunnerRow, report: RunnerReport, now = new Date()) {
    const changed =
      runner.name !== report.machine_name ||
      runner.runnerVersion !== report.runner_version ||
      runner.protocolVersion !== report.protocol_version ||
      canonicalJson(runner.tools) !== canonicalJson(report.tools);
    const stale = !runner.lastSeenAt || now.getTime() - runner.lastSeenAt.getTime() >= RUNNER_SEEN_WRITE_THROTTLE_MS;
    if (changed || stale || runner.offlineNotifiedAt) {
      await this.db
        .update(runners)
        .set({
          lastSeenAt: now,
          name: report.machine_name,
          tools: report.tools as RunnerToolInfo[],
          runnerVersion: report.runner_version,
          protocolVersion: report.protocol_version,
          offlineNotifiedAt: null,
        })
        .where(and(eq(runners.id, runner.id), ne(runners.status, 'revoked')));
    }
    // Versions are recorded BEFORE the refusal so the Runners page can say "needs an update" instead of "offline".
    this.assertProtocolSupported(report.protocol_version);
    const fresh = (await this.db.query.runners.findFirst({ where: eq(runners.id, runner.id) }))!;
    const assigned = fresh.status === 'active' ? await this.assignedAgents([fresh.id]) : new Map<string, Array<{ id: string; name: string }>>();
    return {
      runner: { id: fresh.id, status: fresh.status, chosen_tool: fresh.chosenTool, name: fresh.name },
      protocol: { minimum: RUNNER_PROTOCOL_MIN, maximum: RUNNER_PROTOCOL_MAX, current: RUNNER_PROTOCOL_MAX },
      server_time: now,
      heartbeat_interval_seconds: RUNNER_HEARTBEAT_INTERVAL_SECONDS,
      offline_after_seconds: RUNNER_OFFLINE_AFTER_MS / 1000,
      // Only the agents assigned to THIS Runner, and only once it is turned on: a pending Runner is told about nothing.
      assigned_agents: assigned.get(fresh.id) ?? [],
    };
  }

  // ---------------------------------------------------------------- the person's Runners (owner-only)

  private async ownRunner(workspaceId: string, userId: string, id: string): Promise<RunnerRow> {
    // Someone else's, in another workspace, revoked-and-gone, malformed or absent: all the same 404 (ADR-0018 (b)). Admins included.
    const row = /^[0-9a-f-]{36}$/i.test(id)
      ? await this.db.query.runners.findFirst({ where: and(eq(runners.id, id), eq(runners.workspaceId, workspaceId), eq(runners.userId, userId)) })
      : null;
    if (!row) throw new NotFoundException(NOT_FOUND);
    return row;
  }

  private async assignedAgents(runnerIds: string[]): Promise<Map<string, Array<{ id: string; name: string }>>> {
    const out = new Map<string, Array<{ id: string; name: string }>>();
    if (runnerIds.length === 0) return out;
    const rows = await this.db
      .select({ runnerId: runnerAgents.runnerId, id: runnerAgents.agentId, name: records.title })
      .from(runnerAgents)
      .innerJoin(records, eq(records.id, runnerAgents.agentId))
      .where(and(inArray(runnerAgents.runnerId, runnerIds), isNull(records.deletedAt)));
    for (const r of rows) out.set(r.runnerId, [...(out.get(r.runnerId) ?? []), { id: r.id, name: r.name }]);
    return out;
  }

  /** The caller's own Runners, never anyone else's, and never a revoked one (a removed or cancelled Runner is gone from the page). */
  async list(workspaceId: string, userId: string, now = new Date()) {
    const rows = await this.db.query.runners.findMany({
      where: and(eq(runners.workspaceId, workspaceId), eq(runners.userId, userId), ne(runners.status, 'revoked')),
      orderBy: [desc(runners.createdAt)],
    });
    const agents = await this.assignedAgents(rows.map((r) => r.id));
    return { data: rows.map((r) => presentRunner(r, agents.get(r.id) ?? [], now)) };
  }

  private async present(row: RunnerRow, now: Date) {
    const agents = await this.assignedAgents([row.id]);
    return presentRunner(row, agents.get(row.id) ?? [], now);
  }

  private pickTool(runner: RunnerRow, tool: string): void {
    if (!runner.tools.some((t) => t.id === tool && t.installed)) {
      throw new UnprocessableEntityException(`"${tool}" was not found on this computer. Choose one of: ${runner.tools.filter((t) => t.installed).map((t) => t.id).join(', ') || 'none detected'}.`);
    }
  }

  /**
   * Done: the person's confirmation that this computer may run their agents. Only a PENDING Runner inside its pairing window can be
   * activated; a late Done is `409 pairing_expired` and the person starts again.
   */
  async activate(workspaceId: string, userId: string, id: string, tool: string, now = new Date()) {
    const runner = await this.ownRunner(workspaceId, userId, id);
    if (runner.status === 'revoked') {
      if (runner.revokedReason === 'pairing_expired') throw codedException(409, 'pairing_expired', PAIRING_EXPIRED_MESSAGE);
      if (runner.revokedReason === 'cancelled') throw codedException(409, 'pairing_cancelled', PAIRING_CANCELLED_MESSAGE);
      throw codedException(409, 'not_pending', 'This Runner was removed. Add it again.');
    }
    if (runner.status === 'active') throw codedException(409, 'not_pending', 'This Runner is already turned on.');
    if (runner.pendingExpiresAt && runner.pendingExpiresAt.getTime() <= now.getTime()) {
      await this.revoke(runner, 'pairing_expired', { actorId: null, source: null }, now);
      throw codedException(409, 'pairing_expired', PAIRING_EXPIRED_MESSAGE);
    }
    this.pickTool(runner, tool);
    const [updated] = await this.db
      .update(runners)
      .set({ status: 'active', chosenTool: tool, activatedAt: now, pendingExpiresAt: null, lastSeenAt: runner.lastSeenAt ?? now })
      .where(and(eq(runners.id, runner.id), eq(runners.status, 'pending'), gt(runners.pendingExpiresAt, now)))
      .returning();
    if (!updated) {
      const again = await this.db.query.runners.findFirst({ where: eq(runners.id, runner.id) });
      if (again?.status === 'revoked' && again.revokedReason === 'cancelled') throw codedException(409, 'pairing_cancelled', PAIRING_CANCELLED_MESSAGE);
      throw codedException(409, 'pairing_expired', PAIRING_EXPIRED_MESSAGE);
    }
    await recordRunnerEvent(this.db, { workspaceId, action: 'activated', runner: { id: updated.id, name: updated.name }, actorId: userId, source: 'human', extra: { tool } });
    return this.present(updated, now);
  }

  /** Change which detected tool this Runner's agents use. */
  async setTool(workspaceId: string, userId: string, id: string, tool: string, now = new Date()) {
    const runner = await this.ownRunner(workspaceId, userId, id);
    if (runner.status !== 'active') throw codedException(409, 'not_active', 'Turn this Runner on first (press Done), then choose its tool.');
    this.pickTool(runner, tool);
    const [updated] = await this.db.update(runners).set({ chosenTool: tool }).where(and(eq(runners.id, runner.id), eq(runners.status, 'active'))).returning();
    if (!updated) throw new NotFoundException(NOT_FOUND);
    return this.present(updated, now);
  }

  /** Remove: the owner's own Runner only. Also how a pending one is taken away. */
  async remove(workspaceId: string, userId: string, id: string, actor: { source: ChangeSource }, now = new Date()) {
    const runner = await this.ownRunner(workspaceId, userId, id);
    if (runner.status === 'revoked') throw new NotFoundException(NOT_FOUND);
    await this.revoke(runner, 'removed', { actorId: userId, source: actor.source }, now);
  }

  /**
   * The one place a Runner is revoked (remove, cancel, window expiry, owner left, erasure). It kills the token (a revoked row is
   * refused on its next call), unassigns every agent, and hands the Runner's claimed wakes back to the queue (see below).
   */
  async revoke(runner: RunnerRow, reason: RunnerRevokeReason, actor: { actorId: string | null; source: ChangeSource | null }, now = new Date()): Promise<boolean> {
    const revoked = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(runners)
        .set({ status: 'revoked', revokedAt: now, revokedReason: reason, pendingExpiresAt: null })
        .where(and(eq(runners.id, runner.id), ne(runners.status, 'revoked')))
        .returning();
      if (!row) return false;
      await tx.delete(runnerAgents).where(eq(runnerAgents.runnerId, runner.id));
      await recordRunnerEvent(tx, {
        workspaceId: runner.workspaceId,
        action: 'revoked',
        runner: { id: runner.id, name: runner.name },
        actorId: actor.actorId ?? runner.userId,
        source: actor.source,
        extra: { reason },
      });
      return true;
    });
    if (revoked) await this.returnClaimedWakes(runner.id);
    return revoked;
  }

  /**
   * Removing a Runner returns the wakes it had claimed to the queue (ADR-0021 §3, ticket #1131 AC3).
   *
   * THERE IS NO WAKE QUEUE YET: `agent_wakes` is ticket #1130. This is the documented hook #1130 fills in
   * (`UPDATE agent_wakes SET status = 'queued', runner_id = NULL … WHERE runner_id = $1 AND status = 'claimed'`, in the same
   * transaction as the revoke). Until then there is nothing to return, so AC3's first half is NOT verified by this ticket; its
   * second half (the token is refused on the next call) is, and is tested.
   */
  protected async returnClaimedWakes(runnerId: string): Promise<void> {
    void runnerId;
  }

  // ---------------------------------------------------------------- agent -> Runner assignment

  /** Whether the agent's `AI mode` is "Your own AI", the only mode a Runner serves. Read from the live record, by field and option. */
  private async agentUsesOwnAi(workspaceId: string, agentId: string): Promise<boolean> {
    const agentsDb = await this.db.query.databases.findFirst({
      where: and(eq(databases.workspaceId, workspaceId), eq(databases.isSystem, true), eq(databases.systemKey, 'agents'), isNull(databases.deletedAt)),
      columns: { id: true },
    });
    if (!agentsDb) return false;
    const field = await this.db.query.fields.findFirst({ where: and(eq(fields.databaseId, agentsDb.id), eq(fields.apiName, 'ai_mode')), columns: { id: true } });
    if (!field) return false;
    const option = await this.db.query.selectOptions.findFirst({ where: and(eq(selectOptions.fieldId, field.id), eq(selectOptions.label, 'Your own AI')), columns: { id: true } });
    if (!option) return false;
    const record = await this.db.query.records.findFirst({ where: and(eq(records.id, agentId), eq(records.databaseId, agentsDb.id), isNull(records.deletedAt)), columns: { values: true } });
    return (record?.values as Record<string, unknown> | undefined)?.[field.id] === option.id;
  }

  /** The agent, if the caller may manage its Runner assignment: its owner, or an admin. Anyone else, and an unknown agent, hear the same 404. */
  private async manageableAgent(membership: Membership, userId: string, agentId: string) {
    const identity = /^[0-9a-f-]{36}$/i.test(agentId) ? await resolveAgentIdentity(this.db, membership.workspaceId, agentId) : null;
    if (!identity || (identity.ownerId !== userId && membership.role !== 'admin')) throw new NotFoundException('Agent not found');
    return identity;
  }

  async getAssignment(membership: Membership, userId: string, agentId: string) {
    await this.manageableAgent(membership, userId, agentId);
    const row = await this.db.query.runnerAgents.findFirst({ where: and(eq(runnerAgents.agentId, agentId), eq(runnerAgents.workspaceId, membership.workspaceId)) });
    const runner = row ? await this.db.query.runners.findFirst({ where: eq(runners.id, row.runnerId), columns: { id: true, name: true } }) : null;
    return { runner: runner ? { id: runner.id, name: runner.name } : null };
  }

  /**
   * Sets (or, with null, clears) where an agent runs. A Runner serves ONLY its own owner's agents: the agent reads records as its
   * owner, and its prompts and record text pass through that person's machine and model account (ADR-0021 §3, open question 2).
   * Every way the Runner can be unusable for this agent is the same 422, so an admin cannot learn whether a Runner id exists.
   */
  async assign(membership: Membership, userId: string, agentId: string, runnerId: string | null, actor: { source: ChangeSource }) {
    const identity = await this.manageableAgent(membership, userId, agentId);
    const workspaceId = membership.workspaceId;
    if (runnerId === null) {
      const existing = await this.db.query.runnerAgents.findFirst({ where: and(eq(runnerAgents.agentId, agentId), eq(runnerAgents.workspaceId, workspaceId)) });
      if (existing) {
        await this.db.delete(runnerAgents).where(eq(runnerAgents.agentId, agentId));
        const runner = await this.db.query.runners.findFirst({ where: eq(runners.id, existing.runnerId), columns: { id: true, name: true } });
        if (runner) await recordRunnerEvent(this.db, { workspaceId, action: 'unassigned', runner, actorId: userId, source: actor.source, extra: { agent_id: agentId, agent_name: identity.agentName } });
      }
      return { runner: null };
    }
    if (!(await this.agentUsesOwnAi(workspaceId, agentId))) {
      throw new UnprocessableEntityException('Only an agent whose AI mode is "Your own AI" runs on a Runner. Change its AI mode first.');
    }
    const runner = /^[0-9a-f-]{36}$/i.test(runnerId)
      ? await this.db.query.runners.findFirst({ where: and(eq(runners.id, runnerId), eq(runners.workspaceId, workspaceId), eq(runners.userId, identity.ownerId), eq(runners.status, 'active')) })
      : null;
    if (!runner) {
      throw new UnprocessableEntityException("That Runner is not available for this agent: it must be an active Runner belonging to the agent's owner.");
    }
    await this.db
      .insert(runnerAgents)
      .values({ agentId, workspaceId, runnerId: runner.id, assignedBy: userId })
      .onConflictDoUpdate({ target: runnerAgents.agentId, set: { runnerId: runner.id, assignedBy: userId } });
    await recordRunnerEvent(this.db, { workspaceId, action: 'assigned', runner: { id: runner.id, name: runner.name }, actorId: userId, source: actor.source, extra: { agent_id: agentId, agent_name: identity.agentName } });
    return { runner: { id: runner.id, name: runner.name } };
  }

  // ---------------------------------------------------------------- sweeper support

  /** Pending Runners whose pairing window has closed. */
  expiredPending(now: Date): Promise<RunnerRow[]> {
    return this.db.query.runners.findMany({ where: and(eq(runners.status, 'pending'), lte(runners.pendingExpiresAt, now)) });
  }

  /** Live (pending or active) Runners whose owner no longer holds an active, non-guest membership in the workspace. */
  async ownerGone(): Promise<RunnerRow[]> {
    return this.db
      .select({ r: runners })
      .from(runners)
      .where(
        and(
          ne(runners.status, 'revoked'),
          sql`NOT EXISTS (SELECT 1 FROM ${memberships} m WHERE m.workspace_id = ${runners.workspaceId} AND m.user_id = ${runners.userId} AND m.status = 'active' AND m.role <> 'guest')`,
        ),
      )
      .then((rows) => rows.map((x) => x.r));
  }

  /**
   * Atomically claims the offline notification for every active Runner that has gone silent and has not been announced yet. The
   * claim IS the de-duplication: whoever's UPDATE returns the row sends the one notification, so two sweeps, or two replicas, cannot
   * both. A Runner that comes back (heartbeat) clears the marker and may be announced again for a LATER episode.
   */
  async claimOfflineRunners(now: Date): Promise<RunnerRow[]> {
    const cutoff = new Date(now.getTime() - RUNNER_OFFLINE_AFTER_MS);
    return this.db
      .update(runners)
      .set({ offlineNotifiedAt: now })
      .where(and(eq(runners.status, 'active'), isNull(runners.offlineNotifiedAt), sql`COALESCE(${runners.lastSeenAt}, ${runners.activatedAt}, ${runners.createdAt}) < ${cutoff.toISOString()}::timestamptz`))
      .returning();
  }

  /** The agents on a Runner and who owns each (a notification's recipients: the Runner's owner plus every assigned agent's current owner). */
  async agentOwnersOf(runner: RunnerRow): Promise<{ agents: string[]; owners: string[] }> {
    const agents = (await this.assignedAgents([runner.id])).get(runner.id) ?? [];
    const owners = new Set<string>();
    for (const a of agents) {
      const identity = await resolveAgentIdentity(this.db, runner.workspaceId, a.id);
      if (identity) owners.add(identity.ownerId);
    }
    return { agents: agents.map((a) => a.name), owners: [...owners] };
  }

  /** Failures older than the lockout window are of no further use. */
  async pruneFailures(now: Date): Promise<void> {
    await this.db.delete(runnerPairingFailures).where(lte(runnerPairingFailures.createdAt, new Date(now.getTime() - PAIRING_FAILURE_WINDOW_MS)));
  }
}
