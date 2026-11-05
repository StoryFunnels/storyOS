import { Body, Controller, Delete, ForbiddenException, Get, HttpCode, NotFoundException, Param, Patch, Post, Put, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { AuthGuard } from '../auth/auth.guard';
import { MinRole, WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import { runnerAssignmentSchema, runnerToolChoiceSchema, runnerUpdateSchema } from './runner.dto';
import { GUEST_RUNNER_MESSAGE, RunnersService } from './runners.service';
import { AgentCatchUpService } from './agent-catch-up.service';
import { AgentWakesService } from './agent-wakes.service';

class RunnerToolChoiceDto extends createZodDto(runnerToolChoiceSchema) {}
class RunnerUpdateDto extends createZodDto(runnerUpdateSchema) {}
class RunnerAssignmentDto extends createZodDto(runnerAssignmentSchema) {}

/**
 * Every write here is a PERSON at a keyboard. Pairing a machine, turning it on, switching its tool, removing it and sending an
 * agent to it decide where an agent's instructions and the workspace's data go: a model (even the agent itself) must not be able
 * to route its own prompts, pair a computer or cut off its peers, so an API token, an OAuth connection and an agent credential get
 * 403, the rule minting a token has (tokens.controller.ts) and the reason these routes have no MCP tool (coverage.ts).
 */
function assertPerson(req: WorkspaceRequest, action: string): void {
  if (req.auth?.via !== 'session') {
    throw new ForbiddenException(`Sign in to ${action}: an API token or a connected AI cannot do it. A Runner decides where your agents' work and data go.`);
  }
}

/** A guest never holds a Runner (#1091 rule); a resource-bound token is a guest here too (the guard downgrades its role). */
function assertNotGuest(req: WorkspaceRequest): void {
  if (req.membership.role === 'guest') throw new ForbiddenException(GUEST_RUNNER_MESSAGE);
}

/**
 * ADR-0021 §11 — the app-facing Runner API, in one controller and WITHOUT `@MinRole('admin')`: members are who pair Runners.
 * A Runner is one person's computer and subscription, so list, activate, change and remove are the OWNER's, admins included, and
 * someone else's Runner id is the SAME 404 a nonexistent one gets (ADR-0018 (b): existence is not revealed).
 */
@ApiTags('runners')
@ApiBearerAuth()
@UseGuards(AuthGuard, WorkspaceAccessGuard)
@Controller('workspaces/:ws')
export class RunnersController {
  constructor(
    private readonly runners: RunnersService,
    private readonly catchUp: AgentCatchUpService,
    private readonly wakes: AgentWakesService,
  ) {}

  @Post('runners/pairing-codes')
  @ApiOperation({ summary: 'Start "Add a Runner": a 6-character, single-use pairing code valid about 10 minutes. A new code burns your previous unused one. Not for guests.' })
  issueCode(@Req() req: WorkspaceRequest) {
    assertPerson(req, 'add a Runner');
    return this.runners.issueCode(req.membership, req.user.id);
  }

  @Get('runners/pairing-codes/:id')
  @ApiOperation({ summary: 'Poll a pairing code you issued: waiting, connected (with the Runner and the tools it found), expired or cancelled' })
  codeStatus(@Req() req: WorkspaceRequest, @Param('id') id: string) {
    assertPerson(req, 'add a Runner');
    assertNotGuest(req);
    return this.runners.codeStatus(req.membership.workspaceId, req.user.id, id);
  }

  @Delete('runners/pairing-codes/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Cancel pairing: burns the code AND revokes the pending Runner it produced, at once' })
  async cancelCode(@Req() req: WorkspaceRequest, @Param('id') id: string) {
    assertPerson(req, 'cancel pairing');
    assertNotGuest(req);
    await this.runners.cancelCode(req.membership.workspaceId, req.user.id, id, { source: req.auth.source });
  }

  @Get('runners')
  @MinRole('member') // a guest holds no Runner; this also lets the MCP role gate hide list_runners from guests (role-gates.generated.ts)
  @ApiOperation({ summary: 'Your own Runners (never anyone else\'s, admins included): status, connection, tools, chosen tool, versions, offline_since and the agents on each' })
  list(@Req() req: WorkspaceRequest) {
    assertNotGuest(req);
    return this.runners.list(req.membership.workspaceId, req.user.id);
  }

  @Post('runners/:id/activate')
  @HttpCode(200)
  @ApiOperation({ summary: 'Done: turn a pending Runner on and choose its tool. 409 pairing_expired if the pairing window has closed; 422 if the tool was not found on that computer' })
  activate(@Req() req: WorkspaceRequest, @Param('id') id: string, @Body() body: RunnerToolChoiceDto) {
    assertPerson(req, 'turn on a Runner');
    assertNotGuest(req);
    return this.runners.activate(req.membership.workspaceId, req.user.id, id, body.tool);
  }

  @Patch('runners/:id')
  @ApiOperation({
    summary:
      'Change a Runner you own: which detected tool your agents use (tool), the hours it may claim in (working_hours: days, start, end, IANA timezone; null = any hour) and "leave me X%" (reserve_percent 1-95; null = none). Any subset. The reserve is only kept for a tool that reports plan usage: reserve_measurable says whether.',
  })
  update(@Req() req: WorkspaceRequest, @Param('id') id: string, @Body() body: RunnerUpdateDto) {
    assertPerson(req, 'change a Runner');
    assertNotGuest(req);
    return this.runners.update(req.membership.workspaceId, req.user.id, id, body);
  }

  @Delete('runners/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove a Runner: revokes its token (refused on its next call), unassigns its agents and returns its claimed wakes to the queue. Also how a pending Runner is taken away' })
  async remove(@Req() req: WorkspaceRequest, @Param('id') id: string) {
    assertPerson(req, 'remove a Runner');
    assertNotGuest(req);
    await this.runners.remove(req.membership.workspaceId, req.user.id, id, { source: req.auth.source });
  }

  @Get('runner-assignments/:agent')
  @ApiOperation({ summary: 'Which Runner an agent runs on (the agent\'s owner, or an admin)' })
  getAssignment(@Req() req: WorkspaceRequest, @Param('agent') agent: string) {
    assertNotGuest(req);
    return this.runners.getAssignment(req.membership, req.user.id, agent);
  }

  @Put('runner-assignments/:agent')
  @ApiOperation({
    summary:
      'Send an agent to one of its owner\'s own active Runners, or pass runner_id null to unassign. 422 unless the agent\'s AI mode is "Your own AI" and the Runner is the owner\'s own and active',
  })
  assign(@Req() req: WorkspaceRequest, @Param('agent') agent: string, @Body() body: RunnerAssignmentDto) {
    assertPerson(req, 'choose where an agent runs');
    assertNotGuest(req);
    return this.runners.assign(req.membership, req.user.id, agent, body.runner_id, { source: req.auth.source });
  }

  @Post('agents/:agent/catch-up')
  @HttpCode(200)
  @ApiOperation({
    summary:
      "Start the agent on the records already waiting in its trigger state(s) that no wake was ever made for (ticket #1152): one wake per record through the normal queue, at most 25 per click. Returns {queued, already_waiting, remaining, skipped}; remaining is how many more a further click will queue. The agent's owner or an admin, signed in (a token, a connected AI or the agent's own run credential gets 403; anyone else, and an unknown agent, 404). The count that decides whether to offer this is `catch_up` in GET /agent-wakes/summary.",
  })
  startOnWaiting(@Req() req: WorkspaceRequest, @Param('agent') agent: string) {
    assertPerson(req, 'start an agent on the records already waiting');
    return this.catchUp.run(req.membership, agent);
  }

  @Get('agents/:agent/budget')
  @ApiOperation({
    summary:
      "An agent's monthly budget and what it has used this month (ticket #1138), for the agent's page. `limits` are the two number fields on the agent's record (monthly_token_budget, monthly_run_cap; null = no limit); `tokens` and `runs` each carry limit, used, percent (whole, rounded down), and a state (unlimited, ok, warning at 80%, paused at 100%, not_measured). `tokens.used` is null, never 0, when the finished runs' tool did not report usage; `tokens.measurement` (full, partial, not_reported, no_finished_runs) and `unmeasured_runs` say how much of the total is measured. `state` is the worst of the two; when paused, `paused_reason` names which and `resumes_at` is the UTC month reset (raising the budget resumes it sooner). The month is the UTC calendar month. To set or raise a budget, update those fields on the agent's record (a person; an agent cannot change its own). 404 unless you can read both the agent and the Runs database the numbers are counted from.",
  })
  async budget(@Req() req: WorkspaceRequest, @Param('agent') agent: string) {
    const out = await this.wakes.budgetFor(req.membership, agent);
    if (!out) throw new NotFoundException('Agent not found');
    return out;
  }
}
