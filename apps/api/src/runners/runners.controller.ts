import { Body, Controller, Delete, ForbiddenException, Get, HttpCode, Param, Patch, Post, Put, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { AuthGuard } from '../auth/auth.guard';
import { MinRole, WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import { runnerAssignmentSchema, runnerToolChoiceSchema } from './runner.dto';
import { GUEST_RUNNER_MESSAGE, RunnersService } from './runners.service';

class RunnerToolChoiceDto extends createZodDto(runnerToolChoiceSchema) {}
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
  constructor(private readonly runners: RunnersService) {}

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
  @ApiOperation({ summary: 'Change which detected tool your agents use on this Runner' })
  setTool(@Req() req: WorkspaceRequest, @Param('id') id: string, @Body() body: RunnerToolChoiceDto) {
    assertPerson(req, 'change a Runner');
    assertNotGuest(req);
    return this.runners.setTool(req.membership.workspaceId, req.user.id, id, body.tool);
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
}
