import { Global, Module } from '@nestjs/common';
import { AgentScopeService } from '../agents/agent-scope';
import { RecordsModule } from '../records/records.module';
import { AgentWakesController } from './agent-wakes.controller';
import { AgentWakesService } from './agent-wakes.service';
import { AgentCatchUpService } from './agent-catch-up.service';
import { AgentBudgetService } from './agent-budget.service';
import { SkillsModule } from '../skills/skills.module';
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
  imports: [RecordsModule, SkillsModule],
  controllers: [RunnersController, RunnerApiController, AgentWakesController],
  providers: [AgentScopeService, RunnersService, AgentWakesService, AgentCatchUpService, AgentBudgetService, RunnerAuthGuard, RunnerSweeperService],
  exports: [RunnersService, AgentWakesService, AgentBudgetService],
})
export class RunnersModule {}
