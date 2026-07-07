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

export type Membership = typeof memberships.$inferSelect;
export type WorkspaceRequest = AuthedRequest & { membership: Membership };

const MIN_ROLE_KEY = 'storyos:minRole';
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

    const minRole =
      this.reflector.getAllAndOverride<Role>(MIN_ROLE_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? 'guest';

    if (ROLE_RANK[membership.role] < ROLE_RANK[minRole]) {
      throw new ForbiddenException(`Requires ${minRole} role`);
    }

    (request as WorkspaceRequest).membership = membership;
    return true;
  }
}
