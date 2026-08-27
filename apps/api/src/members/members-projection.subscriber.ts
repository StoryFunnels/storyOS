import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { env } from '../config/env';
import { MembershipEventsService } from '../events/membership-events.service';
import type { MembershipEvent } from '../events/membership-events.service';
import { MembersDbService } from './members-db.service';

/**
 * Projects workspace-membership lifecycle changes into the Members system
 * database (#128 Phase 1). Subscribes to the in-process membership-event bus the
 * same way `AgentTriggerSubscriber` rides the domain-event bus — the membership
 * mutation points (`WorkspacesService.create`, `InvitesService.accept`,
 * `MembersService.update`/`remove`) emit, this handles.
 *
 * Handling is serialized per workspace so two changes never interleave into a
 * duplicate row, and fully isolated: a projection failure never propagates back
 * to the membership mutation that emitted the event (the mutation is the source
 * of truth; the projection catching up late is fine, corrupting it is not).
 *
 * On boot it backfills every existing workspace (the existing-workspace
 * provisioning path) — idempotent, so re-running on each deploy is safe. Skipped
 * under `NODE_ENV=test`, where each test boots the whole app: tests exercise the
 * backfill by calling `MembersDbService.backfillWorkspace` directly instead of
 * paying a full-database sweep on every app boot.
 */
@Injectable()
export class MembersProjectionSubscriber implements OnModuleInit {
  private readonly logger = new Logger(MembersProjectionSubscriber.name);

  /** Serializes handling per workspace, so projections never interleave. */
  private readonly chains = new Map<string, Promise<void>>();

  constructor(
    private readonly membershipEvents: MembershipEventsService,
    private readonly membersDb: MembersDbService,
  ) {}

  onModuleInit(): void {
    this.membershipEvents.subscribe((event) => this.dispatch(event));

    if (env().NODE_ENV !== 'test') {
      // Fire-and-forget: boot must not block on the sweep, and a failure here is
      // a projection gap to notice and retry, never a reason to fail startup.
      void this.membersDb
        .backfillAll()
        .catch((error) => this.logger.warn(`Members boot backfill failed: ${String(error)}`));
    }
  }

  dispatch(event: MembershipEvent): void {
    const chain = this.chains.get(event.workspaceId) ?? Promise.resolve();
    const next = chain
      .then(() => this.handle(event))
      .catch((error) =>
        this.logger.warn(`Members projection failed (${event.type}): ${String(error)}`),
      )
      .finally(() => {
        if (this.chains.get(event.workspaceId) === next) this.chains.delete(event.workspaceId);
      });
    this.chains.set(event.workspaceId, next);
  }

  /** Test hook: awaits the workspace's chain so assertions see projection effects. */
  async settle(workspaceId: string): Promise<void> {
    await (this.chains.get(workspaceId) ?? Promise.resolve());
  }

  private async handle(event: MembershipEvent): Promise<void> {
    if (event.type === 'membership_erased') {
      /*
       * #418 — checked BEFORE `membership_removed`, and they are separate
       * branches on purpose. An erasure that fell through to a tombstone would
       * leave the identity in place and report success.
       */
      await this.membersDb.erasePii(
        event.workspaceId,
        event.userId,
        event.anonymisedEmail ?? '',
        event.tombstone === true,
      );
      return;
    }
    if (event.type === 'membership_removed') {
      await this.membersDb.tombstoneMembership(event.workspaceId, event.userId);
      return;
    }
    await this.membersDb.syncMembership(event.workspaceId, event.userId);
  }
}
