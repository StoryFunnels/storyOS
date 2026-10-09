import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AccessService } from './access.service';
import { MentionNarrowingService } from './mention-narrowing.service';
import { MentionNarrowingInterceptor } from './mention-narrowing.interceptor';
import { RequestMemoInterceptor } from './request-memo';
import { GrantsController } from './grants.controller';

/**
 * Deliberately not importing WorkspacesModule: GrantsController uses
 * WorkspaceAccessGuard only as a class reference in @UseGuards (its own
 * deps — DB, Reflector — are both globally resolvable, so Nest instantiates
 * it directly without needing it registered here), and AccessService has no
 * WorkspacesModule dependency at all. Keeping this edge out is what lets
 * MN-190 (workspaces -> billing -> access) stay a DAG instead of a cycle.
 */
@Global()
@Module({
  controllers: [GrantsController],
  // Order matters: the request memo (#861) must be the OUTER interceptor so its store exists when
  // the mention narrowing (#857) resolves a guest's readable records inside the same request.
  providers: [
    AccessService,
    MentionNarrowingService,
    { provide: APP_INTERCEPTOR, useClass: RequestMemoInterceptor },
    { provide: APP_INTERCEPTOR, useClass: MentionNarrowingInterceptor },
  ],
  exports: [AccessService, MentionNarrowingService],
})
export class AccessModule {}
