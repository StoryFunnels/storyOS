import { ForbiddenException, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { AuthedRequest } from '../auth/auth.guard';
import { PlatformAdminService } from './platform-admin.service';

/**
 * Gates every /admin route. Use AFTER AuthGuard:
 * @UseGuards(AuthGuard, PlatformAdminGuard) — same convention as
 * WorkspaceAccessGuard. 403, not 404: /admin's existence isn't a secret,
 * only who may use it.
 */
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  constructor(private readonly platformAdmins: PlatformAdminService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const user = (request as AuthedRequest).user;
    if (!(await this.platformAdmins.isPlatformAdmin(user.id))) {
      throw new ForbiddenException('Platform admin access required.');
    }
    return true;
  }
}
