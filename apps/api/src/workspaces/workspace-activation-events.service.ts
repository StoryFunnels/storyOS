import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { and, asc, eq, gt, isNull } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { workspaces } from '../db/schema';
import { env } from '../config/env';
import { AnalyticsService, eventUuid } from '../analytics/analytics.service';
import { foundingAdminId } from '../analytics/founding-admin';
import { ActivationService } from './activation.service';

const SWEEP_EVERY_MS = 10 * 60 * 1000;
const PAGE_SIZE = 100;

/**
 * #817 — emits `workspace_activated`, server-side, exactly once per workspace.
 *
 * WHY A SWEEP AND NOT A HOOK ON "A RECORD WAS CREATED": the activation the funnel
 * must see includes people who never touch the web UI — an MCP client or an agent
 * writes the records and the token is minted from a settings page or a CLI. Records
 * are created by the editor, the API, MCP, CSV import, copy-record, templates,
 * automations and agents; a hook on each of those would be a list that is wrong the
 * day a ninth writer is added. A periodic read of the same live state the Getting
 * Started checklist reads counts every path by construction. The price is up to
 * SWEEP_EVERY_MS of latency, which a funnel stage does not care about.
 *
 * EXACTLY ONCE is a hard requirement (a re-emit would inflate the funnel's most
 * important stage), and rests on two independent things:
 *   1. an atomic `UPDATE ... WHERE activated_at IS NULL RETURNING` claim, so two
 *      instances or two overlapping ticks cannot both send; and
 *   2. a deterministic event uuid, which PostHog deduplicates, so even a send that
 *      is retried after a lost response collapses to one event.
 * The claim is released if the SEND fails (PostHog unreachable), so an outage
 * delays the event rather than losing it forever.
 *
 * With analytics unconfigured (every self-hoster) this does nothing at all: no
 * timer, no query, no write — which is also why self-hosted workspaces never gain
 * an `activated_at` value.
 */
@Injectable()
export class WorkspaceActivationEventsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorkspaceActivationEventsService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweeping = false;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly activation: ActivationService,
    private readonly analytics: AnalyticsService,
  ) {}

  onModuleInit() {
    if (env().NODE_ENV !== 'test' && this.analytics.enabled) {
      this.timer = setInterval(() => void this.sweep(), SWEEP_EVERY_MS);
    }
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** One pass over every workspace not yet activated. Returns how many events were sent. */
  async sweep(): Promise<number> {
    if (!this.analytics.enabled || this.sweeping) return 0;
    this.sweeping = true;
    let sent = 0;
    try {
      let after: string | null = null;
      for (;;) {
        const page: Array<{ id: string }> = await this.db
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(and(isNull(workspaces.activatedAt), after ? gt(workspaces.id, after) : undefined))
          .orderBy(asc(workspaces.id))
          .limit(PAGE_SIZE);
        if (page.length === 0) break;
        for (const { id } of page) {
          try {
            if (await this.activateIfReady(id)) sent++;
          } catch (error) {
            // One bad workspace must not stop the sweep for the rest.
            this.logger.warn(`activation check failed for workspace ${id}: ${String(error)}`);
          }
        }
        after = page[page.length - 1]!.id;
      }
    } finally {
      this.sweeping = false;
    }
    return sent;
  }

  /** Public so a test can drive one workspace deterministically. */
  async activateIfReady(workspaceId: string): Promise<boolean> {
    const state = await this.activation.evaluate(workspaceId);
    if (!state.activated) return false;

    // No person to attribute the event to => do not claim, so it is retried rather than lost.
    const person = await foundingAdminId(this.db, workspaceId);
    if (!person) {
      this.logger.debug(`workspace ${workspaceId} is activated but has no active admin to attribute it to`);
      return false;
    }

    const [claimed] = await this.db
      .update(workspaces)
      .set({ activatedAt: new Date() })
      .where(and(eq(workspaces.id, workspaceId), isNull(workspaces.activatedAt)))
      .returning({ createdAt: workspaces.createdAt });
    if (!claimed) return false; // another tick or instance got there first

    const result = await this.analytics.capture({
      distinctId: person,
      event: 'workspace_activated',
      uuid: eventUuid('workspace_activated', workspaceId),
      properties: {
        workspace_id: workspaceId,
        // Which half of the definition held, so "activated via an invite, via AI, or
        // via both" can be compared on retention — the check #13 says would show
        // whether this definition is too strict or too loose.
        teammate_invited: state.teammate_invited,
        ai_connected: state.ai_connected,
        workspace_age_days: Math.floor((Date.now() - claimed.createdAt.getTime()) / 86_400_000),
      },
    });
    if (result === 'sent') return true;

    // Not sent ('failed', or analytics was switched off mid-sweep): release the claim so
    // the event is delayed, never silently lost.
    await this.db.update(workspaces).set({ activatedAt: null }).where(eq(workspaces.id, workspaceId));
    return false;
  }
}
