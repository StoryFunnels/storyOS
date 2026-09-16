import { Body, Controller, Delete, ForbiddenException, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { RequiresScope } from '../auth/token-scope.guard';
import { WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import { ActionGatesService } from './action-gates.service';

const createGatePolicySchema = z.object({
  action_class: z.string().min(1).max(100),
  space_id: z.string().uuid().nullable().optional(),
  database_id: z.string().uuid().nullable().optional(),
  approver_id: z.string().min(1),
});
class CreateGatePolicyDto extends createZodDto(createGatePolicySchema) {}

const updateGatePolicySchema = z.object({
  enabled: z.boolean().optional(),
  approver_id: z.string().min(1).optional(),
});
class UpdateGatePolicyDto extends createZodDto(updateGatePolicySchema) {}

function toDto(row: {
  id: string;
  workspaceId: string;
  spaceId: string | null;
  databaseId: string | null;
  actionClass: string;
  enabled: boolean;
  approverId: string;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    workspace_id: row.workspaceId,
    space_id: row.spaceId,
    database_id: row.databaseId,
    action_class: row.actionClass,
    enabled: row.enabled,
    approver_id: row.approverId,
    created_by: row.createdBy,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

/**
 * #542 Phase 2 — declaring a gate is an operator decision with real
 * consequences (it can pause an agent's write indefinitely), so it is
 * admin-only for BOTH a session and a PAT: `@RequiresScope('admin')` only
 * constrains a token caller (AuthGuard's own documented limit — see
 * `approvals.controller.ts`'s identical comment), so `assertAdmin` below
 * additionally checks a session caller's membership role.
 */
@ApiTags('action-gates')
@UseGuards(AuthGuard, WorkspaceAccessGuard)
@Controller('workspaces/:ws/action-gates')
export class ActionGatesController {
  constructor(private readonly gates: ActionGatesService) {}

  private assertAdmin(req: WorkspaceRequest): void {
    if (req.membership.role !== 'admin') {
      throw new ForbiddenException('Only a workspace admin can declare or change an action-class gate');
    }
  }

  @Get()
  @RequiresScope('admin')
  @ApiOperation({ summary: 'List this workspace\'s declared action-class gate policies' })
  async list(@Req() req: WorkspaceRequest) {
    this.assertAdmin(req);
    const rows = await this.gates.list(req.membership.workspaceId);
    return { data: rows.map(toDto) };
  }

  @Post()
  @RequiresScope('admin')
  @ApiOperation({ summary: 'Declare a gate over an action class (starting with delete_records), scoped to workspace/space/database' })
  async create(@Req() req: WorkspaceRequest, @Body() body: CreateGatePolicyDto) {
    this.assertAdmin(req);
    const created = await this.gates.create({
      workspaceId: req.membership.workspaceId,
      spaceId: body.space_id ?? null,
      databaseId: body.database_id ?? null,
      actionClass: body.action_class,
      approverId: body.approver_id,
      createdBy: req.user.id,
    });
    return toDto(created);
  }

  @Patch(':id')
  @RequiresScope('admin')
  @ApiOperation({ summary: 'Enable/disable a gate policy, or change its approver' })
  async update(@Req() req: WorkspaceRequest, @Param('id') id: string, @Body() body: UpdateGatePolicyDto) {
    this.assertAdmin(req);
    const updated = await this.gates.update(req.membership.workspaceId, id, {
      enabled: body.enabled,
      approverId: body.approver_id,
    });
    return toDto(updated);
  }

  @Delete(':id')
  @RequiresScope('admin')
  @ApiOperation({ summary: 'Remove a gate policy' })
  async remove(@Req() req: WorkspaceRequest, @Param('id') id: string) {
    this.assertAdmin(req);
    await this.gates.remove(req.membership.workspaceId, id);
    return { deleted: true };
  }
}
