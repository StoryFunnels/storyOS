import { Global, Module } from '@nestjs/common';
import { CredentialsController } from './credentials.controller';
import { CredentialsService } from './credentials.service';
import { TokensController } from './tokens.controller';
import { RunCredentialsService } from './run-credentials.service';
import { TokensService } from './tokens.service';

/** Global: AuthGuard (in the global AuthModule) resolves PATs through TokensService. */
@Global()
@Module({
  controllers: [TokensController, CredentialsController],
  providers: [TokensService, CredentialsService, RunCredentialsService],
  exports: [TokensService, RunCredentialsService],
})
export class TokensModule {}
