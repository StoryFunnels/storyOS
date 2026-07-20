import { ForbiddenException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { PlatformAdminService } from './platform-admin.service';
import { PlatformAdminGuard } from './platform-admin.guard';

function contextWithUser(userId: string): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ user: { id: userId } }),
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

  it('rejects a non-admin with 403', async () => {
    const guard = new PlatformAdminGuard(platformAdminsStub(false));
    await expect(guard.canActivate(contextWithUser('u1'))).rejects.toThrow(ForbiddenException);
  });
});
