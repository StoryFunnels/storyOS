import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  SetMetadata,
} from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { and, eq } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { memberships } from '../db/schema';
import type { AuthedRequest } from '../auth/auth.guard';
import { resolveRecordRef } from '../common/record-ref';

export type Membership = typeof memberships.$inferSelect & {
  /**
   * #543 — present only when the request authenticated with a token bound to specific spaces
   * or databases. `role` is then DOWNGRADED to 'guest' (so every guest narrowing already in the
   * codebase applies) and the caller's real role is kept here, because AccessService derives
   * the synthetic grants from it. Never set from anything but the token row.
   *
   * `agentCredential` (ticket #1296) is true when the credential belongs to an AGENT. A whole-space binding then covers the space's
   * USER databases only: a system database (Members, the Agents pack) is closed to it unless named in `databaseIds`. Derived from
   * the credential's agent identity, which the guard re-resolves live on every request, so it can never be set by the caller.
   */
  bound?: { spaceIds: string[]; databaseIds: string[]; realRole: 'admin' | 'member' | 'guest'; agentCredential?: boolean };
};
export type WorkspaceRequest = AuthedRequest & { membership: Membership };

export const MIN_ROLE_KEY = 'storyos:minRole';
const ROLE_RANK = { guest: 0, member: 1, admin: 2 } as const;
export type Role = keyof typeof ROLE_RANK;

/** Minimum role required for the route. Defaults to 'guest' (any member). */
export const MinRole = (role: Role) => SetMetadata(MIN_ROLE_KEY, role);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolves the caller's membership in the :ws workspace (docs/architecture/auth.md).
 * Non-members get 404 — never 403 — to avoid leaking workspace existence.
 * Use AFTER AuthGuard: @UseGuards(AuthGuard, WorkspaceAccessGuard).
 */
@Injectable()
export class WorkspaceAccessGuard implements CanActivate {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const params = request.params as { ws?: string };
    const user = (request as AuthedRequest).user;

    if (!params.ws || !UUID_RE.test(params.ws)) throw new NotFoundException('Workspace not found');

    const membership = await this.db.query.memberships.findFirst({
      where: and(
        eq(memberships.workspaceId, params.ws),
        eq(memberships.userId, user.id),
        eq(memberships.status, 'active'),
      ),
    });
    if (!membership) throw new NotFoundException('Workspace not found');

    const ceiling = (request as AuthedRequest).auth?.resourceScope;
    const effective: Membership = ceiling
      ? {
          ...membership,
          role: 'guest',
          bound: {
            spaceIds: ceiling.space_ids,
            databaseIds: ceiling.database_ids,
            realRole: membership.role,
            ...((request as AuthedRequest).auth?.agentId ? { agentCredential: true } : {}),
          },
        }
      : membership;

    const minRole =
      this.reflector.getAllAndOverride<Role>(MIN_ROLE_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? 'guest';

    if (ROLE_RANK[effective.role] < ROLE_RANK[minRole]) {
      throw new ForbiddenException(
        ceiling
          ? 'This token is bound to specific spaces or databases; this route is outside that boundary'
          : `Requires ${minRole} role`,
      );
    }

    // ticket #1295 — `{rec}` is a uuid or the record's public number on every `records/{rec}/...` route. Resolved here, once, AFTER
    // membership and the role floor (a non-member costs no lookup), so no handler repeats it and a new route in the family is covered
    // without opting in. The uuid it yields goes through every downstream access check unchanged — see common/record-ref.ts.
    const rec = (request.params as { rec?: string; db?: string }).rec;
    if (typeof rec === 'string') {
      (request.params as { rec?: string }).rec = await resolveRecordRef(
        this.db,
        (request.params as { db?: string }).db,
        rec,
      );
    }

    (request as WorkspaceRequest).membership = effective;
    return true;
  }
}
