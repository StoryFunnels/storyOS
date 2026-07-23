import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { createSourceSchema, sourceDiscoverRequestSchema, updateSourceSchema } from '@storyos/schemas';
import { AuthGuard } from '../auth/auth.guard';
import { RequiresScope } from '../auth/token-scope.guard';
import { WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import { DatabasesService } from '../databases/databases.service';
import { SourcesService } from './sources.service';

class CreateSourceDto extends createZodDto(createSourceSchema) {}
class UpdateSourceDto extends createZodDto(updateSourceSchema) {}
class DiscoverSourceDto extends createZodDto(sourceDiscoverRequestSchema) {}

/**
 * #239 — CUD (schema-adjacent: a source's field mapping shapes the target
 * database same as adding a field does) needs `creator`, same rank
 * fields.controller.ts requires; list/runs reads need only `viewer`.
 */
@ApiTags('sources')
@ApiBearerAuth()
@Controller('workspaces/:ws/databases/:db/sources')
@UseGuards(AuthGuard, WorkspaceAccessGuard)
export class SourcesController {
  constructor(
    private readonly sourcesService: SourcesService,
    private readonly databases: DatabasesService,
  ) {}

  private async dbAsViewer(req: WorkspaceRequest, databaseId: string) {
    await this.databases.assertAccess(req.membership, databaseId, 'viewer');
    return databaseId;
  }

  private async dbAsCreator(req: WorkspaceRequest, databaseId: string) {
    await this.databases.assertAccess(req.membership, databaseId, 'creator');
    return databaseId;
  }

  @Get()
  @RequiresScope('read')
  @ApiOperation({ summary: 'List the sources syncing into this database' })
  async list(@Req() req: WorkspaceRequest, @Param('db') databaseId: string) {
    return this.sourcesService.list(await this.dbAsViewer(req, databaseId));
  }

  @Get('providers')
  @RequiresScope('read')
  @ApiOperation({ summary: 'The source provider catalog — what can be synced, and its config shape' })
  async providers(@Req() req: WorkspaceRequest, @Param('db') databaseId: string) {
    await this.dbAsViewer(req, databaseId);
    return this.sourcesService.listProviders();
  }

  @Post('discover')
  @RequiresScope('write')
  @ApiOperation({ summary: 'MN-262: preview a provider\'s field keys before creating a source (point-and-click mapping)' })
  async discover(@Req() req: WorkspaceRequest, @Param('db') databaseId: string, @Body() body: DiscoverSourceDto) {
    await this.dbAsCreator(req, databaseId);
    return this.sourcesService.discover(req.membership.workspaceId, body);
  }

  @Post()
  @RequiresScope('write')
  @ApiOperation({ summary: 'Configure a new source: provider + connection + field mapping + schedule' })
  async create(@Req() req: WorkspaceRequest, @Param('db') databaseId: string, @Body() body: CreateSourceDto) {
    const dbId = await this.dbAsCreator(req, databaseId);
    return this.sourcesService.create(req.membership.workspaceId, dbId, body, req.user.id);
  }

  @Patch(':id')
  @RequiresScope('write')
  @ApiOperation({ summary: 'Reconfigure a source' })
  async update(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Param('id') id: string,
    @Body() body: UpdateSourceDto,
  ) {
    const dbId = await this.dbAsCreator(req, databaseId);
    return this.sourcesService.update(dbId, id, body);
  }

  @Delete(':id')
  @RequiresScope('write')
  @ApiOperation({ summary: 'Stop syncing — leaves every record the source created intact' })
  async remove(@Req() req: WorkspaceRequest, @Param('db') databaseId: string, @Param('id') id: string) {
    const dbId = await this.dbAsCreator(req, databaseId);
    return this.sourcesService.remove(dbId, id);
  }

  @Post(':id/sync-now')
  @RequiresScope('write')
  @ApiOperation({ summary: 'Run one sync cycle immediately, ignoring the schedule gate' })
  async syncNow(@Req() req: WorkspaceRequest, @Param('db') databaseId: string, @Param('id') id: string) {
    const dbId = await this.dbAsCreator(req, databaseId);
    return this.sourcesService.syncNow(dbId, id);
  }

  @Get(':id/runs')
  @RequiresScope('read')
  @ApiOperation({ summary: 'Recent sync runs for one source (fetched/created/updated/errors)' })
  async runs(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Param('id') id: string,
    @Query('limit') limit?: string,
  ) {
    const dbId = await this.dbAsViewer(req, databaseId);
    return this.sourcesService.runs(dbId, id, limit ? Number(limit) : undefined);
  }
}
