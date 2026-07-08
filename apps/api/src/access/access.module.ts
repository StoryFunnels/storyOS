import { Global, Module } from '@nestjs/common';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { AccessService } from './access.service';
import { GrantsController } from './grants.controller';

@Global()
@Module({
  imports: [WorkspacesModule],
  controllers: [GrantsController],
  providers: [AccessService],
  exports: [AccessService],
})
export class AccessModule {}
