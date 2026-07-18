import { Global, Module } from '@nestjs/common';
import { AccessService } from './access.service';
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
  providers: [AccessService],
  exports: [AccessService],
})
export class AccessModule {}
