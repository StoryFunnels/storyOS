import { Injectable } from '@nestjs/common';

/**
 * A workspace-membership lifecycle change (#128). The Members system database is
 * a one-way projection of workspace memberships (better-auth is the identity
 * source of truth), so these are the only signals it reacts to:
 *
 * - `membership_changed` — a membership was created (workspace created, invite
 *   accepted / user joined) or its role changed. The projection ensures the
 *   Members database exists and upserts the person's row as active.
 * - `membership_removed` — a membership was removed. The projection **tombstones**
 *   the row (marks it inactive) rather than deleting it, so records assigned to
 *   that person keep a resolvable Member (#128 Phase 1 decision).
 *
 * `userId` is the better-auth user id — stable across name/email/role changes,
 * so it is the key the projection upserts and tombstones on.
 */
export interface MembershipEvent {
  /**
   * `membership_erased` is NOT a synonym for `membership_removed` (#418).
   *
   * Removal TOMBSTONES: `active` goes false and the name, email and avatar stay,
   * deliberately, so a record assigned to that person still resolves to a human
   * (ADR-0017 §7). That is exactly the wrong behaviour for a GDPR erasure, where
   * the whole point is that the identity goes.
   *
   * So the projection needs to tell them apart, and a boolean flag on
   * `membership_removed` would have been the smaller change and the worse one —
   * a subscriber that forgot to read the flag would silently under-erase, which
   * is the failure mode this exists to prevent.
   */
  type: 'membership_changed' | 'membership_removed' | 'membership_erased';
  workspaceId: string;
  userId: string;
  /**
   * #418 — only on `membership_erased`: the anonymised address the `user` row was
   * given, so the projection writes the SAME value rather than deriving its own.
   *
   * Passed rather than looked up because the erasure has already replaced the
   * row by the time this is handled, and a projection that re-read it would be
   * racing its own cause.
   */
  anonymisedEmail?: string;
  /**
   * #418 — only on `membership_erased`: also mark the row inactive.
   *
   * True for the workspace the erasure ran in (the membership really is gone),
   * false for the person's OTHER workspaces, where the PII must go but the
   * membership stands.
   */
  tombstone?: boolean;
}

type Listener = (event: MembershipEvent) => void;

/**
 * In-process membership-event bus (#128), the exact shape of
 * {@link DomainEventsService} but for membership lifecycle rather than record
 * writes. It exists so the low-level `WorkspacesModule` (which owns the
 * membership mutation points) can notify the higher-level Members projection
 * WITHOUT importing it: `DatabasesModule`/`RecordsModule`/`FieldsModule` already
 * import `WorkspacesModule`, so a direct dependency the other way would be a
 * cycle. The bus lives in the `@Global` `EventsModule`, so emitters need no
 * import at all.
 *
 * Single-node v1 by design, like the domain-event bus.
 */
@Injectable()
export class MembershipEventsService {
  private listeners: Listener[] = [];

  subscribe(listener: Listener): void {
    this.listeners.push(listener);
  }

  emit(event: MembershipEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // listeners are isolated — a bad subscriber never breaks the membership
        // mutation that emitted the event (mirrors DomainEventsService).
      }
    }
  }
}
