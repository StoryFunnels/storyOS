import { Body, Controller, Delete, ForbiddenException, Get, NotFoundException, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { RequiresScope } from '../auth/token-scope.guard';
import { assertHumanSource } from '../auth/assert-human-source';
import { MinRole, WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import { AGENT_WRITE_OPERATIONS, AgentWriteGatesService } from './agent-write-gates.service';

const createSchema = z.object({
  agent_id: z.uuid(),
  operations: z.array(z.enum(AGENT_WRITE_OPERATIONS)).min(1),
  database_id: z.uuid().nullable().optional(),
  fields: z.array(z.string().min(1).max(200)).max(100).nullable().optional(),
});
class CreateAgentWriteGateDto extends createZodDto(createSchema) {}
class UpdateAgentWriteGateDto extends createZodDto(z.object({ enabled: z.boolean().optional() })) {}

function toDto(row: {
  id: string;
  workspaceId: string;
  agentId: string;
  operations: string[];
  databaseId: string | null;
  fields: string[] | null;
  enabled: boolean;
  createdBy: string;
  createdAt: Date;
}) {
  return {
    id: row.id,
    workspace_id: row.workspaceId,
    agent_id: row.agentId,
    operations: row.operations,
    database_id: row.databaseId,
    fields: row.fields,
    enabled: row.enabled,
    created_by: row.createdBy,
    created_at: row.createdAt,
  };
}

/**
 * #1104 — declaring a per-agent write gate. Reading is the admin's, or (#1111) the agent's owner for that one agent (a gate names
 * databases and fields, so nobody else); declaring,
 * switching off or removing one is admin AND a person: the gate is the platform's restraint on an agent, so a token or a
 * connected AI, even one acting for an admin, must not be able to lift it (the same rule approving has, #859).
 */
@ApiTags('agent-write-gates')
@UseGuards(AuthGuard, WorkspaceAccessGuard)
@Controller('workspaces/:ws/agent-write-gates')
export class AgentWriteGatesController {
  constructor(private readonly gates: AgentWriteGatesService) {}

  private assertAdminPerson(req: WorkspaceRequest): void {
    assertHumanSource(req);
    if (req.membership.role !== 'admin') {
      throw new ForbiddenException('Only a workspace admin can declare or change a gate on an agent\'s writes');
    }
  }

  /**
   * #1111 — who reads. The route is member-role at the guard with a `read` scope; the decision is made here:
   *  - an ADMIN reads any/all, exactly as before, and still needs an ADMIN-scoped token (#1049: an admin-role route must not
   *    be reachable by an admin's read/write token — the route stopped being @MinRole('admin'), so the handler keeps that rule);
   *  - an agent's OWNER (a member) reads THAT agent's gates, read-only: `agent_id` is required and must be an agent they own;
   *  - anyone else, and an unknown / malformed / not-owned agent, hears the same 404 (nothing about which it was);
   *  - an agent-scoped token never takes the owner path: an agent must not read the gates on its own writes.
   * Guests (and resource-bound tokens, which are guests) never reach this: the guard refuses below member.
   */
  @Get()
  @MinRole('member')
  @RequiresScope('read')
  @ApiOperation({
    summary:
      'List the gates that hold an agent\'s record create/update for approval (an admin: any agent or all; the agent\'s owner: that agent only, agent_id required)',
  })
  async list(@Req() req: WorkspaceRequest, @Query('agent_id') agentId?: string) {
    const workspaceId = req.membership.workspaceId;
    if (req.membership.role === 'admin') {
      if (req.auth?.via === 'token' && req.auth.tokenScope !== 'admin') {
        throw new ForbiddenException('Reading the gates on agents\' writes as an admin needs an admin-scoped token');
      }
      const rows = await this.gates.list(workspaceId, agentId);
      return { data: rows.map(toDto) };
    }
    const owns = !!agentId && !req.auth?.agentId && (await this.gates.isOwner(workspaceId, agentId, req.user.id));
    if (!owns) throw new NotFoundException('Agent not found');
    const rows = await this.gates.list(workspaceId, agentId);
    return { data: rows.map(toDto) };
  }

  @Post()
  @MinRole('admin')
  @RequiresScope('admin')
  @ApiOperation({
    summary:
      'Gate an agent\'s record create and/or update for approval, optionally limited to one database and to named fields (a person who is an admin)',
  })
  async create(@Req() req: WorkspaceRequest, @Body() body: CreateAgentWriteGateDto) {
    this.assertAdminPerson(req);
    const created = await this.gates.create({
      workspaceId: req.membership.workspaceId,
      agentId: body.agent_id,
      operations: body.operations,
      databaseId: body.database_id ?? null,
      fields: body.fields ?? null,
      createdBy: req.user.id,
    });
    return toDto(created);
  }

  @Patch(':id')
  @MinRole('admin')
  @RequiresScope('admin')
  @ApiOperation({ summary: 'Switch an agent write gate on or off (a person who is an admin)' })
  async update(@Req() req: WorkspaceRequest, @Param('id') id: string, @Body() body: UpdateAgentWriteGateDto) {
    this.assertAdminPerson(req);
    return toDto(await this.gates.update(req.membership.workspaceId, id, { enabled: body.enabled }));
  }

  @Delete(':id')
  @MinRole('admin')
  @RequiresScope('admin')
  @ApiOperation({ summary: 'Remove an agent write gate (a person who is an admin)' })
  async remove(@Req() req: WorkspaceRequest, @Param('id') id: string) {
    this.assertAdminPerson(req);
    await this.gates.remove(req.membership.workspaceId, id);
    return { deleted: true };
  }
}
