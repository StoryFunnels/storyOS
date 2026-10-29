import { Global, Module } from '@nestjs/common';
import { AgentWakesController } from './agent-wakes.controller';
import { AgentWakesService } from './agent-wakes.service';
import { RunnerApiController } from './runner-api.controller';
import { RunnerAuthGuard } from './runner-auth.guard';
import { RunnerSweeperService } from './runner-sweeper.service';
import { RunnersController } from './runners.controller';
import { RunnersService } from './runners.service';

/**
 * #1131 / ADR-0021 — the StoryOS Runner: pairing, the runner token, heartbeat, offline detection, owner-only list and remove, and
 * the agent→Runner assignment. Global because the throttler (app-wide) buckets a Runner's requests by its own token.
 */
@Global()
@Module({
  controllers: [RunnersController, RunnerApiController, AgentWakesController],
  providers: [RunnersService, AgentWakesService, RunnerAuthGuard, RunnerSweeperService],
  exports: [RunnersService, AgentWakesService],
})
export class RunnersModule {}
