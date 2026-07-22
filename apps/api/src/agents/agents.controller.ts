import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { MinRole, WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import { AgentsService } from './agents.service';

/** A `(database, state, agent)` binding (#211, ADR-0010 §5). */
const createTriggerSchema = z.object({
  /** The agent record's uuid or public number. */
  agent: z.string().min(1),
  database_id: z.uuid(),
  /** The select field on that database whose options are the states. */
  state_field_id: z.uuid(),
  /** The option that fires the agent when a record enters it. */
  state_option_id: z.uuid(),
  /** A gated state never auto-fires an agent out of it — humans only. */
  human_gate: z.boolean().optional(),
  enabled: z.boolean().optional(),
});

class CreateAgentTriggerDto extends createZodDto(createTriggerSchema) {}

/** #44: the record to delegate — becomes the run's context (`inputRecordId`). */
const delegateSchema = z.object({ record_id: z.uuid() });
class DelegateToAgentDto extends createZodDto(delegateSchema) {}

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
  @ApiOperation({
    summary: 'Provision the Agentic OS space + Agents/Runs/Agent Triggers databases (idempotent)',
  })
  ensure(@Req() req: WorkspaceRequest) {
    return this.agents.ensurePack(req.membership);
  }

  /**
   * Create a state-transition binding (#211, ADR-0010 §5).
   *
   * The only bespoke write on the Agent Triggers database, and only because the
   * binding's ids need validating against live schema (422 if the state field
   * isn't a select, or the option isn't its own). Listing, editing and removing
   * bindings go through the normal records API on that database.
   */
  @Post('triggers')
  @ApiOperation({ summary: 'Bind an agent to a state on a database; returns the binding record' })
  createTrigger(@Req() req: WorkspaceRequest, @Body() body: CreateAgentTriggerDto) {
    return this.agents.createBinding(req.membership, body);
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

  /**
   * Delegate to agent (#44) — the integrations-directory flagship card: assign
   * an agent to a record. It runs exactly like a manual run (#208), with that
   * record as its context, and posts its outcome back on the record as a
   * comment (with a chip linking to the full Run) once it finishes.
   */
  @Post(':agent/delegate')
  @ApiParam({ name: 'agent', description: "The agent record's uuid or public number" })
  @ApiOperation({
    summary: 'Delegate a record to an agent — it runs with the record as context and posts progress back as a comment',
  })
  delegate(@Req() req: WorkspaceRequest, @Param('agent') agent: string, @Body() body: DelegateToAgentDto) {
    return this.agents.delegate(req.membership, agent, body.record_id);
  }

  /**
   * Approve a parked run (#210, ADR-0010 §4) — the gate pass.
   *
   * This is where the staged action finally happens: it was proposed as data and
   * has been sitting in the Run's `Pending action` untouched. 422 unless the run
   * is actually Waiting approval, so a verdict can't be applied twice or to a run
   * that never asked.
   */
  @Post('runs/:run/approve')
  @ApiParam({ name: 'run', description: "The run record's uuid or public number" })
  @ApiOperation({ summary: 'Approve a run waiting for approval: apply the staged action' })
  approveRun(@Req() req: WorkspaceRequest, @Param('run') run: string) {
    return this.agents.approveRun(req.membership, run);
  }

  /**
   * Reject a parked run (#210, ADR-0010 §4).
   *
   * Applies nothing — and needs to undo nothing, because staging means the action
   * was never performed in the first place. The run cancels with no side effects.
   */
  @Post('runs/:run/reject')
  @ApiParam({ name: 'run', description: "The run record's uuid or public number" })
  @ApiOperation({ summary: 'Reject a run waiting for approval: apply nothing, cancel it' })
  rejectRun(@Req() req: WorkspaceRequest, @Param('run') run: string) {
    return this.agents.rejectRun(req.membership, run);
  }
}
