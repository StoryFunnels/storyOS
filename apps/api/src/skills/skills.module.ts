import { Module } from '@nestjs/common';
import { SkillsController } from './skills.controller';
import { SkillsService } from './skills.service';

/**
 * #40 — the Skills framework. Standalone: it needs no other feature module
 * (DbModule is @Global(), and the principal-scope helper it reuses,
 * scopeForRole, is a pure function imported straight from
 * agents/agent-principal.ts rather than pulling in all of AgentsModule).
 * Exported so a later ticket (#41's MCP tool exposure) can inject
 * SkillsService exactly like ConnectionsModule/AutomationsModule are reused
 * today.
 */
@Module({
  controllers: [SkillsController],
  providers: [SkillsService],
  exports: [SkillsService],
})
export class SkillsModule {}
