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
  // Registration order is NOT load-bearing, and measured so (swapping the two lines leaves every
  // test green): the request memo's store (#861) rides the async context of the handler's own
  // promise chain, so the mention narrowing (#857) sees it whichever interceptor is outer. What IS
  // enforced is the property that matters: a guest response that goes through the narrowing still
  // reads access_grants once (test/guest-grant-memo.test.ts, "x #857"); it goes red if the
  // narrowing starts doing its own grant read.
  providers: [
    AccessService,
    MentionNarrowingService,
    { provide: APP_INTERCEPTOR, useClass: RequestMemoInterceptor },
    { provide: APP_INTERCEPTOR, useClass: MentionNarrowingInterceptor },
  ],
  exports: [AccessService, MentionNarrowingService],
})
export class AccessModule {}
