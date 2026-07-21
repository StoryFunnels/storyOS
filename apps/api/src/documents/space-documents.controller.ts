import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import { SpaceDocumentsService } from './space-documents.service';

// #283: max(16) was too small even for existing `set:<name>` refs (e.g.
// `set:layout-dashboard` is 20 chars) — bumped to match the max(48) convention
// used by createSpaceSchema/createDatabaseSchema. The service
// (SpaceDocumentsService) normalizes any raw emoji through the migration
// table before it's persisted, so this bound only needs to fit a `set:` ref
// or a short emoji.
const createSchema = z.object({ title: z.string().max(200).optional(), icon: z.string().max(48).optional() });
class CreateSpaceDocDto extends createZodDto(createSchema) {}

const updateSchema = z.object({
  title: z.string().max(200).optional(),
  icon: z.string().max(48).nullable().optional(),
  content: z.unknown().optional(),
  expected_version: z.number().int().min(0).optional(),
});
class UpdateSpaceDocDto extends createZodDto(updateSchema) {}

@ApiTags('documents')
@ApiBearerAuth()
@Controller('workspaces/:ws')
@UseGuards(AuthGuard, WorkspaceAccessGuard)
export class SpaceDocumentsController {
  constructor(private readonly docs: SpaceDocumentsService) {}

  @Get('spaces/:space/documents')
  @ApiOperation({ summary: 'Standalone documents in a space (MN-095)' })
  async list(@Req() req: WorkspaceRequest, @Param('space') space: string) {
    return { data: await this.docs.list(req.membership.workspaceId, space) };
  }

  @Post('spaces/:space/documents')
  @ApiOperation({ summary: 'Create a standalone document in a space' })
  async create(@Req() req: WorkspaceRequest, @Param('space') space: string, @Body() body: CreateSpaceDocDto) {
    return this.docs.create(req.membership.workspaceId, space, body, req.user.id);
  }

  @Get('documents/:doc')
  @ApiOperation({ summary: 'A standalone document (BlockNote content + version)' })
  async get(@Req() req: WorkspaceRequest, @Param('doc') doc: string) {
    return this.docs.get(req.membership.workspaceId, doc);
  }

  @Patch('documents/:doc')
  @ApiOperation({ summary: 'Update title/icon/content — 409 on version conflict' })
  async update(@Req() req: WorkspaceRequest, @Param('doc') doc: string, @Body() body: UpdateSpaceDocDto) {
    return this.docs.update(req.membership.workspaceId, doc, body);
  }

  @Delete('documents/:doc')
  @ApiOperation({ summary: 'Delete a standalone document' })
  async remove(@Req() req: WorkspaceRequest, @Param('doc') doc: string) {
    return this.docs.remove(req.membership.workspaceId, doc);
  }
}
