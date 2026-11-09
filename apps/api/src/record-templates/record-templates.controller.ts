import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import {
  applyRecordTemplateSchema,
  createRecordTemplateSchema,
  saveRecordAsTemplateSchema,
  updateRecordTemplateSchema,
} from '@storyos/schemas';
import { HoldsAgentDeletes } from '../action-gates/agent-delete-route';
import { AuthGuard } from '../auth/auth.guard';
import { DatabasesService } from '../databases/databases.service';
import { WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import { RecordTemplatesService } from './record-templates.service';

class CreateRecordTemplateDto extends createZodDto(createRecordTemplateSchema) {}
class SaveRecordAsTemplateDto extends createZodDto(saveRecordAsTemplateSchema) {}
class UpdateRecordTemplateDto extends createZodDto(updateRecordTemplateSchema) {}
class ApplyRecordTemplateDto extends createZodDto(applyRecordTemplateSchema) {}

/**
 * ticket #1218 - record templates of one database. Anyone who can see the database lists them; making a record from one needs
 * what creating a record needs (contributor); authoring, saving from a record, editing and deleting a template is editor work, because
 * a template is shared content every contributor's "New" offers.
 */
@ApiTags('record-templates')
@ApiBearerAuth()
@Controller('workspaces/:ws/databases/:db/record-templates')
@UseGuards(AuthGuard, WorkspaceAccessGuard)
export class RecordTemplatesController {
  constructor(
    private readonly templates: RecordTemplatesService,
    private readonly databases: DatabasesService,
  ) {}

  @Get()
  @ApiOperation({ summary: "List a database's record templates (name, preset values, body)" })
  async list(@Req() req: WorkspaceRequest, @Param('db') databaseId: string) {
    await this.databases.assertAccess(req.membership, databaseId, 'viewer');
    return { data: await this.templates.list(databaseId) };
  }

  @Get(':template')
  @ApiOperation({ summary: 'One record template' })
  async get(@Req() req: WorkspaceRequest, @Param('db') databaseId: string, @Param('template') templateId: string) {
    await this.databases.assertAccess(req.membership, databaseId, 'viewer');
    return this.templates.get(databaseId, templateId);
  }

  @Post()
  @ApiOperation({ summary: 'Create a record template: name, preset values keyed by field api_name, and a Markdown body' })
  async create(@Req() req: WorkspaceRequest, @Param('db') databaseId: string, @Body() body: CreateRecordTemplateDto) {
    await this.databases.assertAccess(req.membership, databaseId, 'editor');
    return this.templates.create(req.membership, databaseId, body);
  }

  @Post('from-record')
  @ApiOperation({ summary: 'Save an existing record as a template: its values and description (not its title, links or computed fields)' })
  async saveFromRecord(@Req() req: WorkspaceRequest, @Param('db') databaseId: string, @Body() body: SaveRecordAsTemplateDto) {
    await this.databases.assertAccess(req.membership, databaseId, 'editor');
    return this.templates.saveFromRecord(req.membership, databaseId, body.record_id, body);
  }

  @Patch(':template')
  @ApiOperation({ summary: 'Edit a record template (a pack-installed one too: it is then kept on uninstall as changed)' })
  async update(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Param('template') templateId: string,
    @Body() body: UpdateRecordTemplateDto,
  ) {
    await this.databases.assertAccess(req.membership, databaseId, 'editor');
    return this.templates.update(databaseId, templateId, body);
  }

  @Delete(':template')
  @HoldsAgentDeletes('record_template')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a record template. Records already made from it are untouched.' })
  async remove(@Req() req: WorkspaceRequest, @Param('db') databaseId: string, @Param('template') templateId: string) {
    await this.databases.assertAccess(req.membership, databaseId, 'editor');
    await this.templates.remove(databaseId, templateId, req.membership.userId);
  }

  @Post(':template/records')
  @ApiOperation({
    summary:
      'Create a record from a template: preset values and the body are filled in; `values` overrides a preset. Presets that no longer fit the schema are dropped and listed in `skipped`.',
  })
  async apply(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Param('template') templateId: string,
    @Body() body: ApplyRecordTemplateDto,
  ) {
    await this.databases.assertAccess(req.membership, databaseId, 'contributor');
    return this.templates.apply(req.membership, databaseId, templateId, body.values, {
      source: req.auth?.source ?? 'human',
      agentId: req.auth?.agentId,
      agentName: req.auth?.agentName,
    });
  }
}
