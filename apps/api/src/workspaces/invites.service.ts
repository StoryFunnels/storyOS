import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  UnprocessableEntityException,
} from '@nestjs/common';
import { and, eq, isNotNull, isNull, lt } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { invites, memberships, user, workspaces } from '../db/schema';
import { AccessService } from '../access/access.service';
import type { GrantInput } from '../access/access.service';
import { env } from '../config/env';
import { EmailService } from '../mail/email.service';
import type { AuthedUser } from '../auth/auth.guard';
import type { InviteDetailsResponse, InviteDetailsStatus, MembershipRole } from '@storyos/schemas';
import { codedException } from '../common/coded-exception';
import { hashInviteToken } from './invite-token';
import { BillingService } from '../billing/billing.service';
import { EntitlementsService } from '../billing/entitlements.service';
import { SalesSignalService } from '../billing/sales-signal.service';
import { MembershipEventsService } from '../events/membership-events.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RECORD_SHARE_NOTICE } from '../access/mention-narrowing';

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** #177: throttle repeat resends of the same pending invite. There's no
 * dedicated last-sent column, so we derive the last send from `expiresAt`
 * (always set to now + TTL on each send) — see `resend()`. */
const RESEND_COOLDOWN_MS = 60 * 1000;
/**
 * Ticket #1304 — how long a revoked invite is kept as a tombstone ("revoked, ask <inviter>") before the row, and the invited
 * address on it, is deleted. After that the link reads like one that never existed (the neutral not_found body). There was no
 * invite cleanup before this, so the bound is stated here and enforced by `purgeRevoked()` (hourly, plus once at start-up).
 */
export const REVOKED_INVITE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const PURGE_INTERVAL_MS = 60 * 60 * 1000;

const sha256 = hashInviteToken;

/** Ticket #1302 — the ONE body for every token that names no live-or-spent invite. Frozen so no code path can decorate it. */
const INVITE_NOT_FOUND: InviteDetailsResponse = Object.freeze({
  status: 'not_found',
  inviter_name: null,
  workspace_name: null,
  workspace_logo_url: null,
  invited_email: null,
});

/** admin/member count; a guest never does, at any grant role (ticket #1258). Mirrors AccessService.billableUserIds. */
function invitedRoleIsBillable(role: MembershipRole): boolean {
  return role === 'admin' || role === 'member';
}

@Injectable()
export class InvitesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(InvitesService.name);
  private purgeTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly access: AccessService,
    private readonly billing: BillingService,
    private readonly entitlements: EntitlementsService,
    private readonly salesSignal: SalesSignalService,
    private readonly emailService: EmailService,
    private readonly membershipEvents: MembershipEventsService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit() {
    if (env().NODE_ENV === 'test') return;
    const run = () => void this.purgeRevoked().catch((error) => this.logger.warn(`revoked-invite purge failed: ${String(error)}`));
    run();
    this.purgeTimer = setInterval(run, PURGE_INTERVAL_MS);
    this.purgeTimer.unref();
  }

  onModuleDestroy() {
    if (this.purgeTimer) clearInterval(this.purgeTimer);
  }

  /** Ticket #1304 — delete revoked-invite tombstones older than {@link REVOKED_INVITE_RETENTION_MS}. Touches nothing but revoked rows. Returns the count. */
  async purgeRevoked(now: Date = new Date()): Promise<number> {
    const gone = await this.db
      .delete(invites)
      .where(and(isNotNull(invites.revokedAt), lt(invites.revokedAt, new Date(now.getTime() - REVOKED_INVITE_RETENTION_MS))))
      .returning({ id: invites.id });
    return gone.length;
  }

  async create(
    workspaceId: string,
    invitedBy: string,
    input: { email: string; role: MembershipRole; grants?: GrantInput[] },
  ) {
    // #945 — a member invite carries its grants (they matter once something is restricted); an admin needs none, and a
    // record-scoped grant is a guest-only shape (ADR-0018 §7). Refused here, never silently dropped at accept.
    if (input.grants?.length) {
      if (input.role === 'admin') throw new UnprocessableEntityException('An admin already sees everything; invite without grants');
      if (input.role === 'member' && input.grants.some((g) => g.record_id)) {
        throw new UnprocessableEntityException('A member cannot be shared a single record; share its database, or invite them as a guest');
      }
    }
    // MN-190: block at the moment the admin acts, not the invitee's accept —
    // Free has no seat-overage price, so this is the only real ceiling.
    if (invitedRoleIsBillable(input.role)) {
      const allowed = await this.entitlements.can(workspaceId, 'add_seat');
      if (!allowed) {
        // #650 AC2 — hooked at the EXISTING rejection, not a new detection
        // path. Fire-and-forget: a sales-touch failing must never be the
        // reason an admin can't see why their invite was refused.
        void this.salesSignal.maybeFire(workspaceId, 'free_seats_blocked');
        throw new HttpException(
          'Free plan is limited to 2 members — upgrade to Pro to invite more.',
          HttpStatus.PAYMENT_REQUIRED,
        );
      }
    }

    const token = randomBytes(24).toString('base64url');
    const email = input.email.toLowerCase();
    const values = {
      role: input.role,
      grants: input.role === 'admin' ? null : input.grants,
      tokenHash: sha256(token),
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      invitedBy,
    };

    // Re-inviting the same address refreshes the pending invite (new token) rather
    // than stacking duplicate rows.
    const existing = await this.db.query.invites.findFirst({
      where: and(
        eq(invites.workspaceId, workspaceId),
        eq(invites.email, email),
        isNull(invites.acceptedAt),
        isNull(invites.revokedAt), // #1304 — a tombstone is not "the pending invite": re-inviting must mint a fresh row
      ),
    });
    const [invite] = existing
      ? await this.db.update(invites).set(values).where(eq(invites.id, existing.id)).returning()
      : await this.db
          .insert(invites)
          .values({ workspaceId, email, ...values })
          .returning();

    const acceptUrl = await this.sendInviteEmail(workspaceId, email, input.role, token);

    // accept_url returned so admins can copy-share it when SMTP is absent (A2).
    return {
      id: invite!.id,
      email: invite!.email,
      role: invite!.role,
      accept_url: acceptUrl,
      // #857: a record-scoped guest sees mentions of records they cannot read as a redaction.
      ...(input.grants?.some((g) => g.record_id) ? { notice: RECORD_SHARE_NOTICE } : {}),
    };
  }

  /**
   * Emails the branded invite for `token` and returns the plaintext accept URL.
   * Shared by `create()` and `resend()` so both send through exactly the same
   * path (MN-147 workspace-named template, MN-194 cost attribution).
   */
  private async sendInviteEmail(
    workspaceId: string,
    email: string,
    role: MembershipRole,
    token: string,
  ): Promise<string> {
    const acceptUrl = `${env().WEB_URL}/invite?token=${token}`;
    // MN-147: the branded invite email's subject/heading name the workspace —
    // a cheap extra lookup on the (uncommon, admin-triggered) invite path.
    const workspace = await this.db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
    await this.emailService.send(
      {
        kind: 'invite',
        to: email,
        role,
        acceptUrl,
        workspaceName: workspace?.name ?? 'StoryOS',
      },
      workspaceId, // MN-194 — attributes this send's cost to the workspace that invited
    );
    return acceptUrl;
  }

  /**
   * #177: re-send a pending invite with a fresh token + reset expiry, returning
   * the new accept link so the admin can copy-share it. Throttled to one send
   * per {@link RESEND_COOLDOWN_MS}; the last-sent instant is `expiresAt - TTL`
   * since every send stamps `expiresAt = now + TTL`.
   */
  async resend(workspaceId: string, inviteId: string) {
    const invite = await this.db.query.invites.findFirst({
      where: and(
        eq(invites.id, inviteId),
        eq(invites.workspaceId, workspaceId),
        isNull(invites.acceptedAt),
        isNull(invites.revokedAt), // #1304 — a revoked invite cannot be resent (that would un-revoke it)
      ),
    });
    if (!invite) throw new NotFoundException('Invite not found');

    const lastSentAt = invite.expiresAt.getTime() - INVITE_TTL_MS;
    if (Date.now() - lastSentAt < RESEND_COOLDOWN_MS) {
      throw new HttpException(
        'This invitation was just sent — wait a minute before resending.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const token = randomBytes(24).toString('base64url');
    const [updated] = await this.db
      .update(invites)
      .set({ tokenHash: sha256(token), expiresAt: new Date(Date.now() + INVITE_TTL_MS) })
      .where(eq(invites.id, invite.id))
      .returning();

    const acceptUrl = await this.sendInviteEmail(workspaceId, invite.email, invite.role, token);

    return { id: updated!.id, email: updated!.email, role: updated!.role, accept_url: acceptUrl };
  }

  async listPending(workspaceId: string) {
    return (
      await this.db.query.invites.findMany({
        where: and(eq(invites.workspaceId, workspaceId), isNull(invites.acceptedAt), isNull(invites.revokedAt)),
      })
    ).map(({ id, email, role, grants, expiresAt, createdAt }) => ({
      id,
      email,
      role,
      grants,
      expires_at: expiresAt,
      created_at: createdAt,
    }));
  }

  /**
   * Ticket #1304 — a revoke KEEPS the row and stamps `revoked_at`, so the link can say "revoked, ask <inviter>" rather than reading as
   * one that never existed. Only a pending invite can be revoked: an accepted one stays `used` (it was never revoked) and an
   * already-revoked one is a 404, like the deleted row it replaces. `deleted: true` is kept in the response for existing callers.
   */
  async revoke(workspaceId: string, inviteId: string) {
    const [revoked] = await this.db
      .update(invites)
      .set({ revokedAt: new Date() })
      .where(and(eq(invites.id, inviteId), eq(invites.workspaceId, workspaceId), isNull(invites.acceptedAt), isNull(invites.revokedAt)))
      .returning({ id: invites.id });
    if (!revoked) throw new NotFoundException('Invite not found');
    return { deleted: true };
  }

  /**
   * Ticket #1302 — what a person holding an invite link may see BEFORE they sign in: who invited them, to what, for which address,
   * and whether the link still works. No credential, so the token is the only thing that names an invite, and this answers
   * nothing about any other:
   *
   *  - Unknown, malformed (missing, wrong type, absurd length) and replaced tokens take the SAME path: the value is hashed
   *    and looked up once, whatever it is, and the one neutral body comes back. A malformed token is hashed as the empty string
   *    (which no real token can equal) instead of returning early, so "bad shape" is not a faster, distinguishable answer.
   *  - Only the five fields below leave this method: never the token or its hash, a member or invite id, the role or grants, the
   *    inviter's email, or anything about another invite. The invited address is the one the invite was SENT to (the holder of
   *    the link is, by construction, whoever that mailbox reached).
   *  - `expired`, `used` and (ticket #1304) `revoked` keep the details (the screen says "ask <inviter> for a new link"): a revoke
   *    keeps a tombstone row, so a revoked link reveals exactly what an expired or used one does (inviter name, workspace name and
   *    logo, the invited address) and nothing more. That is the contract: the holder of the link already has the token, the
   *    inviter chose to invite that address, and a revoked link is no more sensitive than a spent one. Once the tombstone is purged
   *    (REVOKED_INVITE_RETENTION_MS) it reads as `not_found` again.
   */
  async details(token: unknown): Promise<InviteDetailsResponse> {
    const raw = typeof token === 'string' && token.length <= 256 ? token : '';
    const invite = await this.db.query.invites.findFirst({ where: eq(invites.tokenHash, sha256(raw)) });
    if (!invite) return INVITE_NOT_FOUND;

    const [inviter, workspace] = await Promise.all([
      invite.invitedBy ? this.db.query.user.findFirst({ where: eq(user.id, invite.invitedBy), columns: { name: true } }) : undefined,
      this.db.query.workspaces.findFirst({ where: eq(workspaces.id, invite.workspaceId), columns: { name: true, settings: true } }),
    ]);
    if (!workspace) return INVITE_NOT_FOUND;
    const branding = (workspace.settings as Record<string, unknown> | null)?.['branding'] as { logo_url?: string | null } | undefined;
    const status: InviteDetailsStatus = invite.acceptedAt
      ? 'used'
      : invite.revokedAt
        ? 'revoked' // before expiry: "the inviter withdrew it" is the more useful answer than "it ran out"
        : invite.expiresAt.getTime() < Date.now()
          ? 'expired'
          : 'valid';
    return {
      status,
      inviter_name: inviter?.name?.trim() || null,
      workspace_name: workspace.name,
      workspace_logo_url: branding?.logo_url ?? null,
      invited_email: invite.email,
    };
  }

  /** Token-based accept — not workspace-scoped; the token implies the workspace. */
  async accept(user: AuthedUser, token: string) {
    const invite = await this.db.query.invites.findFirst({
      where: eq(invites.tokenHash, sha256(token)),
    });
    // Ticket #1302 — stable codes, same statuses and messages as before. Used, replaced and never-issued stay one answer.
    if (!invite || invite.acceptedAt) throw codedException(404, 'invite_not_found', 'Invite not found');
    // Ticket #1304 — a revoked invite keeps its row, so it is refused here by name (404 like not-found/expired), before the expiry
    // and address checks: it never depends on who is asking.
    if (invite.revokedAt) throw codedException(404, 'invite_revoked', 'This invite was revoked');
    if (invite.expiresAt.getTime() < Date.now()) throw codedException(404, 'invite_expired', 'Invite expired');
    if (invite.email !== user.email.toLowerCase()) {
      throw codedException(403, 'invite_email_mismatch', 'This invite was issued for a different email address');
    }
    // Ticket #1347 — the address matches, but matching is only a string comparison, and an account that already existed at this
    // address may never have proven the mailbox (someone else may have registered it). Joining needs an address the account has
    // VERIFIED: an account created through this link is verified at creation (auth.ts), anyone else uses the emailed link first.
    // This does NOT stop someone who holds the link and knows the address from signing up through the link and joining: that is
    // the accepted magic-link risk, controlled by expiry and revoke. Checked AFTER the address so the answer for someone else's
    // invite never depends on the caller's verification state, and BEFORE anything is written, so a refusal creates no
    // membership and does not burn the token: once verified, the same link works.
    if (!user.emailVerified) {
      throw codedException(
        403,
        'invite_email_unverified',
        'Verify your email address to join. Send a verification email, open the link in it, then accept this invite again.',
      );
    }

    const existing = await this.db.query.memberships.findFirst({
      where: and(
        eq(memberships.workspaceId, invite.workspaceId),
        eq(memberships.userId, user.id),
      ),
    });
    if (existing) throw codedException(409, 'already_a_member', 'Already a member of this workspace');

    const membership = await this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(memberships)
        .values({
          workspaceId: invite.workspaceId,
          userId: user.id,
          role: invite.role,
          status: 'active',
          invitedBy: invite.invitedBy,
        })
        .returning();
      // #1304 — consumed only while still pending: a revoke (or a second accept) that landed since the read above wins, and
      // throwing rolls the membership insert back, so a revoked link can never admit anyone.
      const [consumed] = await tx
        .update(invites)
        .set({ acceptedAt: new Date() })
        .where(and(eq(invites.id, invite.id), isNull(invites.acceptedAt), isNull(invites.revokedAt)))
        .returning({ id: invites.id });
      if (!consumed) {
        const now = await tx.query.invites.findFirst({ where: eq(invites.id, invite.id), columns: { acceptedAt: true } });
        if (now?.acceptedAt) throw codedException(404, 'invite_not_found', 'Invite not found'); // lost a race to another accept
        throw codedException(404, 'invite_revoked', 'This invite was revoked');
      }
      return created!;
    });

    if (invite.role !== 'admin' && Array.isArray(invite.grants)) {
      await this.access.createGrants(
        invite.workspaceId,
        user.id,
        invite.grants as GrantInput[],
        invite.invitedBy ?? user.id,
      );
    }

    // MN-190: push the (possibly new) seat overage onto Stripe now that the
    // membership is real. Failure here must never block the accept itself —
    // the seat exists either way; a missed sync is a billing gap to notice
    // and retry, not a reason to leave someone unable to join.
    await this.billing.syncSeatQuantity(invite.workspaceId).catch(() => undefined);

    // #650 AC2 — a billable role just became a real, active seat (billableUserIds
    // only counts active memberships, so this is the actual crossing point, not
    // invite creation). Never throws; fire-and-forget like the sync above.
    if (invitedRoleIsBillable(invite.role)) {
      void this.salesSignal.checkSeatCrossing(invite.workspaceId);
    }

    // #128: a joined member/guest projects into the Members system database.
    // Emitted after the membership is committed and isolated inside the bus, so
    // it never blocks or fails the accept — the membership is the source of
    // truth either way (same reasoning as the billing sync above).
    this.membershipEvents.emit({
      type: 'membership_changed',
      workspaceId: membership.workspaceId,
      userId: user.id,
    });

    // #650 AC3 — tell the inviter their invite was accepted. Awaited (it's one
    // notification insert + a fire-and-forget email handoff, not a network
    // round trip) but errors never fail the accept — same reasoning as the
    // billing sync above. `invitedBy` is nullable (a legacy/system-created
    // invite has none) so this is a no-op then.
    if (invite.invitedBy) {
      await this.notifyInviteAccepted(invite.invitedBy, invite.workspaceId, user, invite.role).catch(() => undefined);
    }

    return { workspace_id: membership.workspaceId, role: membership.role };
  }

  private async notifyInviteAccepted(
    inviterId: string,
    workspaceId: string,
    accepted: AuthedUser,
    role: MembershipRole,
  ): Promise<void> {
    await this.notifications.notify({
      workspaceId,
      actorId: accepted.id,
      type: 'invite_accepted',
      recipients: [inviterId],
      snippet: `${accepted.email} joined as ${role}`,
    });

    const inviter = await this.db.query.user.findFirst({ where: eq(user.id, inviterId) });
    if (!inviter) return;
    const workspace = await this.db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
    await this.emailService.send(
      {
        kind: 'invite-accepted',
        to: inviter.email,
        workspaceName: workspace?.name ?? 'StoryOS',
        memberEmail: accepted.email,
        role,
        membersUrl: `${env().WEB_URL.replace(/\/$/, '')}/w/${workspace?.slug ?? ''}/settings/members`,
      },
      workspaceId,
    );
  }
}
