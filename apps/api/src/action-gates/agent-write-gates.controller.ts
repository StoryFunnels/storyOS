import { Body, Controller, Delete, ForbiddenException, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
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
 * #1104 — declaring a per-agent write gate. Reading is admin-only (a gate names databases and fields); declaring,
 * switching off or removing one is admin AND a person: the gate is the platform's restraint on an agent, so a token or a
 * connected AI, even one acting for an admin, must not be able to lift it (the same rule approving has, #859).
 */
@ApiTags('agent-write-gates')
@UseGuards(AuthGuard, WorkspaceAccessGuard)
@MinRole('admin')
@Controller('workspaces/:ws/agent-write-gates')
export class AgentWriteGatesController {
  constructor(private readonly gates: AgentWriteGatesService) {}

  private assertAdmin(req: WorkspaceRequest): void {
    if (req.membership.role !== 'admin') {
      throw new ForbiddenException('Only a workspace admin can see the gates on agents\' writes: they name databases and fields');
    }
  }

  private assertAdminPerson(req: WorkspaceRequest): void {
    assertHumanSource(req);
    if (req.membership.role !== 'admin') {
      throw new ForbiddenException('Only a workspace admin can declare or change a gate on an agent\'s writes');
    }
  }

  // No `@RequiresScope('read')` override: this is an admin-role route, so a token needs ADMIN scope even to read (#1049: an admin's write/read token must not reach admin-role routes).
  @Get()
  @ApiOperation({ summary: 'List the gates that hold an agent\'s record create/update for approval (optionally for one agent)' })
  async list(@Req() req: WorkspaceRequest, @Query('agent_id') agentId?: string) {
    this.assertAdmin(req); // a gate names databases and fields a member or guest may not be allowed to see
    const rows = await this.gates.list(req.membership.workspaceId, agentId);
    return { data: rows.map(toDto) };
  }

  @Post()
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
  @RequiresScope('admin')
  @ApiOperation({ summary: 'Switch an agent write gate on or off (a person who is an admin)' })
  async update(@Req() req: WorkspaceRequest, @Param('id') id: string, @Body() body: UpdateAgentWriteGateDto) {
    this.assertAdminPerson(req);
    return toDto(await this.gates.update(req.membership.workspaceId, id, { enabled: body.enabled }));
  }

  @Delete(':id')
  @RequiresScope('admin')
  @ApiOperation({ summary: 'Remove an agent write gate (a person who is an admin)' })
  async remove(@Req() req: WorkspaceRequest, @Param('id') id: string) {
    this.assertAdminPerson(req);
    await this.gates.remove(req.membership.workspaceId, id);
    return { deleted: true };
  }
}
