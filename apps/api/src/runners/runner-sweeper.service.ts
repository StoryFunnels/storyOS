import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { env } from '../config/env';
import { NotificationsService } from '../notifications/notifications.service';
import { RUNNER_SWEEP_INTERVAL_MS } from './runner.constants';
import { RunnersService } from './runners.service';

/**
 * ADR-0021 §3 — the one periodic pass over Runners. Same shape as TrialRemindersService / AutoReloadRetryService: a `setInterval`
 * (not in tests) around a public `sweep(now)` a test can call with a controlled clock, with each unit of work isolated so one bad
 * Runner never stops the rest.
 *
 *  1. A PENDING Runner nobody activated inside the pairing window is revoked (Cancel, a closed tab, a walk away: the same end).
 *  2. A Runner whose owner is no longer an active member is revoked (the sweeper is the backstop; the guard already refuses it).
 *  3. An ACTIVE Runner silent past the offline gap is announced ONCE per offline episode, to the people whose agents are stuck on
 *     it. Going offline is not stored (`offline_since` is derived); only the de-duplication marker is.
 *  4. Wrong-guess records past the lockout window are dropped.
 *
 * "Manager": there is no manager concept for agents in the code. An agent's owner is the record's creator (agent-identity.ts), and
 * the ADR names the owner. The recipients are the agents' owners on that Runner, plus the Runner's own owner when it carries agents.
 * A Runner with no agent on it is NOT announced (a sleeping laptop with nothing assigned is not news), though the episode is still
 * marked so assigning an agent later does not produce a stale "went offline" about the past.
 */
@Injectable()
export class RunnerSweeperService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RunnerSweeperService.name);
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly runners: RunnersService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit() {
    if (env().NODE_ENV !== 'test') this.timer = setInterval(() => void this.sweep(), RUNNER_SWEEP_INTERVAL_MS);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async sweep(now = new Date()): Promise<{ expired: number; ownerGone: number; offlineAnnounced: number }> {
    let expired = 0;
    let ownerGone = 0;
    let offlineAnnounced = 0;

    for (const runner of await this.runners.expiredPending(now)) {
      try {
        if (await this.runners.revoke(runner, 'pairing_expired', { actorId: null, source: null }, now)) expired++;
      } catch (error) {
        this.logger.warn(`could not expire pending Runner ${runner.id}: ${String(error)}`);
      }
    }

    for (const runner of await this.runners.ownerGone()) {
      try {
        if (await this.runners.revoke(runner, 'member_inactive', { actorId: null, source: null }, now)) ownerGone++;
      } catch (error) {
        this.logger.warn(`could not revoke Runner ${runner.id} of a departed member: ${String(error)}`);
      }
    }

    for (const runner of await this.runners.claimOfflineRunners(now)) {
      try {
        const { agents, owners } = await this.runners.agentOwnersOf(runner);
        if (agents.length === 0) continue;
        const recipients = [...new Set([runner.userId, ...owners])];
        await this.notifications.notify({
          workspaceId: runner.workspaceId,
          actorId: runner.userId,
          type: 'runner_offline',
          recipients,
          // The person IS the Runner's owner; this is a heads-up about their own machine, so it must reach them.
          allowSelf: true,
          snippet: `${runner.name} stopped responding. Waiting for it: ${agents.slice(0, 5).join(', ')}${agents.length > 5 ? ` and ${agents.length - 5} more` : ''}.`,
        });
        offlineAnnounced++;
      } catch (error) {
        this.logger.warn(`offline notification failed for Runner ${runner.id}: ${String(error)}`);
      }
    }

    try {
      await this.runners.pruneFailures(now);
    } catch (error) {
      this.logger.warn(`pairing failure prune failed: ${String(error)}`);
    }
    return { expired, ownerGone, offlineAnnounced };
  }
}
