import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { RequiresScope } from '../auth/token-scope.guard';
import { MinRole } from '../workspaces/workspace-access.guard';
import { WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import { GroupsService } from './groups.service';

const createSchema = z.object({ name: z.string().trim().min(1).max(100), color: z.string().max(32).optional() });
class CreateGroupDto extends createZodDto(createSchema) {}

const updateSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  color: z.string().max(32).nullable().optional(),
  position: z.number().int().optional(),
});
class UpdateGroupDto extends createZodDto(updateSchema) {}

/**
 * #742 finding 04 — presentational-only sidebar tier above spaces. Every
 * route here is workspace-scoped and admin-only, same as FoldersController,
 * and NONE of them may ever gate access to a space or anything inside one —
 * that would cross the D1/S2 tripwire this table's schema comment warns about.
 */
@ApiTags('spaces')
@ApiBearerAuth()
@Controller('workspaces/:ws/space-groups')
@UseGuards(AuthGuard, WorkspaceAccessGuard)
@RequiresScope('admin')
export class GroupsController {
  constructor(private readonly groups: GroupsService) {}

  @Get()
  @ApiOperation({ summary: 'Presentational sidebar groups (#742 finding 04)' })
  async list(@Req() req: WorkspaceRequest) {
    return { data: await this.groups.list(req.membership.workspaceId) };
  }

  @Post()
  @MinRole('member')
  @ApiOperation({ summary: 'Create a sidebar group' })
  async create(@Req() req: WorkspaceRequest, @Body() body: CreateGroupDto) {
    return this.groups.create(req.membership.workspaceId, body);
  }

  @Patch(':group')
  @MinRole('member')
  @ApiOperation({ summary: 'Rename / re-colour / reorder a sidebar group' })
  async update(@Req() req: WorkspaceRequest, @Param('group') group: string, @Body() body: UpdateGroupDto) {
    return this.groups.update(req.membership.workspaceId, group, body);
  }

  @Delete(':group')
  @MinRole('member')
  @ApiOperation({ summary: 'Delete a sidebar group (its spaces fall back to ungrouped)' })
  async remove(@Req() req: WorkspaceRequest, @Param('group') group: string) {
    return this.groups.remove(req.membership.workspaceId, group);
  }
}
