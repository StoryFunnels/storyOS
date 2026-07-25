import { Global, Module } from '@nestjs/common';
import { DeploymentService } from './deployment.service';

/**
 * #345 — provides the deployment-mode signal (hosted vs self-managed) app-wide.
 * @Global so any module that needs to branch on hosted-vs-self-managed (the
 * connections catalog today, more of the "cloud vs self-managed integrations"
 * initiative later) can inject DeploymentService without re-importing this.
 */
@Global()
@Module({
  providers: [DeploymentService],
  exports: [DeploymentService],
})
export class DeploymentModule {}
