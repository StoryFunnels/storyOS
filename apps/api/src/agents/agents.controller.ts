import { Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import { MinRole, WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import { AgentsService } from './agents.service';

/**
 * Agents system database (MN-214a, ADR-0010). Admin-only, mirroring the
 * integrations pack controllers. Agent *records* are managed through the normal
 * records API on the provisioned database — this controller only provisions and
 * reports the pack.
 */
@ApiTags('agents')
@UseGuards(AuthGuard, WorkspaceAccessGuard)
@MinRole('admin')
@Controller('workspaces/:ws/agents')
export class AgentsController {
  constructor(private readonly agents: AgentsService) {}

  @Get()
  @ApiOperation({ summary: 'Agents database summary, or { exists: false } if not provisioned' })
  getPack(@Req() req: WorkspaceRequest) {
    return this.agents.getPack(req.membership);
  }

  @Post('ensure')
  @ApiOperation({ summary: 'Provision the Agentic OS space + Agents/Runs databases (idempotent)' })
  ensure(@Req() req: WorkspaceRequest) {
    return this.agents.ensurePack(req.membership);
  }

  /**
   * Run an agent by hand (#208, ADR-0010 §3). Works with no LLM: the run class
   * is stamped at dispatch and the step log is written to the Run record. A
   * runtime error lands as a Failed run, never as a 500.
   */
  @Post(':agent/run')
  @ApiParam({ name: 'agent', description: "The agent record's uuid or public number" })
  @ApiOperation({ summary: 'Run an agent manually; returns the Run record' })
  run(@Req() req: WorkspaceRequest, @Param('agent') agent: string) {
    return this.agents.run(req.membership, agent);
  }
}
