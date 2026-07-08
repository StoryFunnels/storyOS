import {
  ConflictException,
  ForbiddenException,
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
import { sendMail } from '../mail/mailer';
import type { AuthedUser } from '../auth/auth.guard';
import type { MembershipRole } from '@storyos/schemas';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

@Injectable()
export class InvitesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly access: AccessService,
  ) {}

  async create(
    workspaceId: string,
    invitedBy: string,
    input: { email: string; role: MembershipRole; grants?: GrantInput[] },
  ) {
    const token = randomBytes(24).toString('base64url');
    const [invite] = await this.db
      .insert(invites)
      .values({
        workspaceId,
        email: input.email.toLowerCase(),
        role: input.role,
        grants: input.role === 'guest' ? input.grants : null,
        tokenHash: sha256(token),
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
        invitedBy,
      })
      .returning();

    const acceptUrl = `${env().WEB_URL}/invite?token=${token}`;
    await sendMail({
      to: input.email,
      subject: `You're invited to StoryOS`,
      text: `You've been invited to a StoryOS workspace as ${input.role}. Accept: ${acceptUrl}`,
    });

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
    return { workspace_id: membership.workspaceId, role: membership.role };
  }
}
