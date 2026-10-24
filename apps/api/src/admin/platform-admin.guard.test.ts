import { ForbiddenException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { PlatformAdminService } from './platform-admin.service';
import { PlatformAdminGuard } from './platform-admin.guard';

function contextWithUser(userId: string, via: 'session' | 'token' | 'oauth' = 'session'): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ user: { id: userId }, auth: { via } }),
    }),
  } as unknown as ExecutionContext;
}

function platformAdminsStub(isAdmin: boolean): PlatformAdminService {
  return { isPlatformAdmin: vi.fn().mockResolvedValue(isAdmin) } as unknown as PlatformAdminService;
}

describe('PlatformAdminGuard', () => {
  it('allows a platform admin through', async () => {
    const guard = new PlatformAdminGuard(platformAdminsStub(true));
    await expect(guard.canActivate(contextWithUser('u1'))).resolves.toBe(true);
  });

  // #1049 — a platform admin's token or AI connection is not a person at a keyboard: refused, and the admin check is never reached.
  it.each(['token', 'oauth'] as const)('rejects a platform admin who arrives by %s with 403, without asking whether they are an admin', async (via) => {
    const admins = platformAdminsStub(true);
    await expect(new PlatformAdminGuard(admins).canActivate(contextWithUser('u1', via))).rejects.toThrow(/signed-in session/);
    expect(admins.isPlatformAdmin).not.toHaveBeenCalled();
  });

  it('rejects a non-admin with 403', async () => {
    const guard = new PlatformAdminGuard(platformAdminsStub(false));
    await expect(guard.canActivate(contextWithUser('u1'))).rejects.toThrow(ForbiddenException);
  });
});
