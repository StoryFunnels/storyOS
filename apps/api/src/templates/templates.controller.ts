import { Body, Controller, Delete, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { MinRole, WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import { TemplatesService } from './templates.service';

const applyTemplateSchema = z.object({
  space_id: z.uuid().optional(),
  space_name: z.string().trim().min(1).max(100).optional(),
  include_samples: z.boolean().default(true),
});
class ApplyTemplateDto extends createZodDto(applyTemplateSchema) {}

@ApiTags('templates')
@ApiBearerAuth()
@Controller()
@UseGuards(AuthGuard)
export class TemplatesController {
  constructor(private readonly templates: TemplatesService) {}

  @Get('templates')
  @ApiOperation({ summary: 'Available starter templates' })
  list() {
    return this.templates.list();
  }
}

@ApiTags('templates')
@ApiBearerAuth()
@Controller('workspaces/:ws/templates')
@UseGuards(AuthGuard, WorkspaceAccessGuard)
@MinRole('member')
export class WorkspaceTemplatesController {
  constructor(private readonly templates: TemplatesService) {}

  @Post(':slug/apply')
  @ApiOperation({ summary: 'Install a template (packs create a space; database templates take space_id)' })
  apply(
    @Req() req: WorkspaceRequest,
    @Param('slug') slug: string,
    @Body() body: ApplyTemplateDto,
  ) {
    return this.templates.apply(req.membership, slug, req.user.id, body);
  }

  @Delete('sample-data')
  @ApiOperation({ summary: 'Remove exactly the sample records templates created' })
  removeSamples(@Req() req: WorkspaceRequest) {
    return this.templates.removeSampleData(req.membership.workspaceId);
  }
}
