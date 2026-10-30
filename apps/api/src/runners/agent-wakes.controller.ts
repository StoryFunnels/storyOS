import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
import { AuthGuard } from '../auth/auth.guard';
import { WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import { AgentWakesService } from './agent-wakes.service';

const listQuerySchema = z.object({
  agent: z.string().max(64).optional(),
  record: z.string().max(64).optional(),
  cursor: z.string().max(400).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
class WakeListQueryDto extends createZodDto(listQuerySchema) {}

/**
 * ADR-0021 §11 (g, h): the queue, read. Any `read` caller, and every row is filtered by what THAT caller may read: a wake whose
 * record or whose Agents database the caller cannot read is omitted AND not counted, so a count never reveals what a 404 would hide.
 * Reads only: nothing here claims, creates or cancels a wake. Wakes are made by what happens in the workspace, and claimed by a
 * Runner on its own routes.
 */
@ApiTags('agent-wakes')
@ApiBearerAuth()
@UseGuards(AuthGuard, WorkspaceAccessGuard)
@Controller('workspaces/:ws/agent-wakes')
export class AgentWakesController {
  constructor(private readonly wakes: AgentWakesService) {}

  @Get()
  @ApiOperation({
    summary:
      'The wake queue, newest first: which agent was woken about which record, why, and ONE derived run_state per row (needs_approval, running, done, failed, canceled, waiting_for_runner, runner_offline, waiting_for_limit, waiting_for_turn). Filter by ?agent= and ?record=. Wakes you cannot read are omitted.',
  })
  list(@Req() req: WorkspaceRequest, @Query() q: WakeListQueryDto) {
    return this.wakes.list(req.membership, q);
  }

  @Get('summary')
  @ApiOperation({
    summary:
      'Waiting counts: per Your-own-AI agent, its Runner, whether it can run, and how many wakes wait for it; plus the total and how many agents cannot run. Wakes you cannot read are not counted.',
  })
  summary(@Req() req: WorkspaceRequest) {
    return this.wakes.summary(req.membership);
  }
}
