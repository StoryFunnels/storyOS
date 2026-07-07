import { Controller, Delete, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import { MinRole, WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import { TemplatesService } from './templates.service';

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
  @ApiOperation({ summary: 'Install a template: space + databases + relations + views + sample data' })
  apply(@Req() req: WorkspaceRequest, @Param('slug') slug: string) {
    return this.templates.apply(req.membership, slug, req.user.id);
  }

  @Delete('sample-data')
  @ApiOperation({ summary: 'Remove exactly the sample records templates created' })
  removeSamples(@Req() req: WorkspaceRequest) {
    return this.templates.removeSampleData(req.membership.workspaceId);
  }
}
