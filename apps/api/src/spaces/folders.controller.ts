import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { MinRole } from '../workspaces/workspace-access.guard';
import { WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import { FoldersService } from './folders.service';

const createSchema = z.object({ name: z.string().trim().min(1).max(100), icon: z.string().max(16).optional() });
class CreateFolderDto extends createZodDto(createSchema) {}

const updateSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  icon: z.string().max(16).nullable().optional(),
  position: z.number().int().optional(),
});
class UpdateFolderDto extends createZodDto(updateSchema) {}

@ApiTags('spaces')
@ApiBearerAuth()
@Controller('workspaces/:ws')
@UseGuards(AuthGuard, WorkspaceAccessGuard)
export class FoldersController {
  constructor(private readonly folders: FoldersService) {}

  @Get('spaces/:space/folders')
  @ApiOperation({ summary: 'Folders in a space (MN-096)' })
  async list(@Req() req: WorkspaceRequest, @Param('space') space: string) {
    return { data: await this.folders.list(req.membership.workspaceId, space) };
  }

  @Post('spaces/:space/folders')
  @MinRole('member')
  @ApiOperation({ summary: 'Create a folder in a space' })
  async create(@Req() req: WorkspaceRequest, @Param('space') space: string, @Body() body: CreateFolderDto) {
    return this.folders.create(req.membership.workspaceId, space, body);
  }

  @Patch('folders/:folder')
  @MinRole('member')
  @ApiOperation({ summary: 'Rename / re-icon / reorder a folder' })
  async update(@Req() req: WorkspaceRequest, @Param('folder') folder: string, @Body() body: UpdateFolderDto) {
    return this.folders.update(req.membership.workspaceId, folder, body);
  }

  @Delete('folders/:folder')
  @MinRole('member')
  @ApiOperation({ summary: 'Delete a folder (its items fall back to the space root)' })
  async remove(@Req() req: WorkspaceRequest, @Param('folder') folder: string) {
    return this.folders.remove(req.membership.workspaceId, folder);
  }
}
