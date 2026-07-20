import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { invites, memberships } from '../db/schema';
import { AccessService } from '../access/access.service';
import type { GrantInput } from '../access/access.service';
import { env } from '../config/env';
import { EmailService } from '../mail/email.service';
import type { AuthedUser } from '../auth/auth.guard';
import type { MembershipRole } from '@storyos/schemas';
import { BillingService } from '../billing/billing.service';
import { EntitlementsService } from '../billing/entitlements.service';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** admin/member always count; a guest only counts once it can create/edit (MN-121). */
function invitedRoleIsBillable(role: MembershipRole, grants: GrantInput[] | undefined): boolean {
  if (role === 'admin' || role === 'member') return true;
  if (role === 'guest') return (grants ?? []).some((g) => g.role === 'contributor' || g.role === 'editor' || g.role === 'creator');
  return false;
}

@Injectable()
export class InvitesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly access: AccessService,
    private readonly billing: BillingService,
    private readonly entitlements: EntitlementsService,
    private readonly emailService: EmailService,
  ) {}

  async create(
    workspaceId: string,
    invitedBy: string,
    input: { email: string; role: MembershipRole; grants?: GrantInput[] },
  ) {
    // MN-190: block at the moment the admin acts, not the invitee's accept —
    // Free has no seat-overage price, so this is the only real ceiling.
    if (invitedRoleIsBillable(input.role, input.grants)) {
      const allowed = await this.entitlements.can(workspaceId, 'add_seat');
      if (!allowed) {
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
      grants: input.role === 'guest' ? input.grants : null,
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
      ),
    });
    const [invite] = existing
      ? await this.db.update(invites).set(values).where(eq(invites.id, existing.id)).returning()
      : await this.db
          .insert(invites)
          .values({ workspaceId, email, ...values })
          .returning();

    const acceptUrl = `${env().WEB_URL}/invite?token=${token}`;
    await this.emailService.send({ kind: 'invite', to: email, role: input.role, acceptUrl });

    // accept_url returned so admins can copy-share it when SMTP is absent (A2).
    return { id: invite!.id, email: invite!.email, role: invite!.role, accept_url: acceptUrl };
  }

  async listPending(workspaceId: string) {
    return (
      await this.db.query.invites.findMany({
        where: and(eq(invites.workspaceId, workspaceId), isNull(invites.acceptedAt)),
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

  async revoke(workspaceId: string, inviteId: string) {
    const [gone] = await this.db
      .delete(invites)
      .where(and(eq(invites.id, inviteId), eq(invites.workspaceId, workspaceId)))
      .returning();
    if (!gone) throw new NotFoundException('Invite not found');
    return { deleted: true };
  }

  /** Token-based accept — not workspace-scoped; the token implies the workspace. */
  async accept(user: AuthedUser, token: string) {
    const invite = await this.db.query.invites.findFirst({
      where: eq(invites.tokenHash, sha256(token)),
    });
    if (!invite || invite.acceptedAt) throw new NotFoundException('Invite not found');
    if (invite.expiresAt.getTime() < Date.now()) throw new NotFoundException('Invite expired');
    if (invite.email !== user.email.toLowerCase()) {
      throw new ForbiddenException('This invite was issued for a different email address');
    }

    const existing = await this.db.query.memberships.findFirst({
      where: and(
        eq(memberships.workspaceId, invite.workspaceId),
        eq(memberships.userId, user.id),
      ),
    });
    if (existing) throw new ConflictException('Already a member of this workspace');

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
      await tx.update(invites).set({ acceptedAt: new Date() }).where(eq(invites.id, invite.id));
      return created!;
    });

    if (invite.role === 'guest' && Array.isArray(invite.grants)) {
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

    return { workspace_id: membership.workspaceId, role: membership.role };
  }
}
