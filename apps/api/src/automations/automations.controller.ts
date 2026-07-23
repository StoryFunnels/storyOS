import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { createAutomationSchema, updateAutomationSchema } from '@storyos/schemas';
import { AuthGuard } from '../auth/auth.guard';
import { RequiresScope } from '../auth/token-scope.guard';
import { WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import { DatabasesService } from '../databases/databases.service';
import { AutomationsService } from './automations.service';

class CreateAutomationDto extends createZodDto(createAutomationSchema) {}
class UpdateAutomationDto extends createZodDto(updateAutomationSchema) {}
class TestAutomationDto extends createZodDto(
  z.object({
    record_id: z.uuid(),
    /** MN-263: when set, "send test request" mode — renders + actually sends
     * ONE action (must be http_request) instead of a dry-run summary. */
    action_index: z.number().int().min(0).optional(),
  }),
) {}

/** Automation rules CRUD + runs + dry-run (MN-047). Creator-gated. */
@ApiTags('automations')
@UseGuards(AuthGuard, WorkspaceAccessGuard)
@Controller('workspaces/:ws/databases/:db/automations')
@RequiresScope('admin')
export class AutomationsController {
  constructor(
    private readonly automationsService: AutomationsService,
    private readonly databases: DatabasesService,
  ) {}

  private creator(req: WorkspaceRequest, databaseId: string) {
    return this.databases.assertAccess(req.membership, databaseId, 'creator');
  }

  @Get()
  @ApiOperation({ summary: 'List rules' })
  async list(@Req() req: WorkspaceRequest, @Param('db') databaseId: string) {
    await this.creator(req, databaseId);
    return this.automationsService.list(databaseId);
  }

  @Post()
  @ApiOperation({ summary: 'Create a rule (trigger + condition + actions)' })
  async create(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Body() body: CreateAutomationDto,
  ) {
    await this.creator(req, databaseId);
    return this.automationsService.create(
      req.membership.workspaceId,
      databaseId,
      body as never,
      req.user.id,
    );
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update / enable / disable a rule' })
  async update(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Param('id') id: string,
    @Body() body: UpdateAutomationDto,
  ) {
    await this.creator(req, databaseId);
    return this.automationsService.update(
      req.membership.workspaceId,
      databaseId,
      id,
      body as never,
      req.user.id,
    );
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a rule' })
  async remove(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Param('id') id: string,
  ) {
    await this.creator(req, databaseId);
    return this.automationsService.remove(databaseId, id);
  }

  @Get(':id/runs')
  @ApiOperation({ summary: 'Run history (30-day retention)' })
  async runs(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Param('id') id: string,
  ) {
    await this.creator(req, databaseId);
    return this.automationsService.runs(databaseId, id);
  }

  @Post(':id/test')
  @ApiOperation({ summary: 'Dry-run a rule against one record' })
  async test(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Param('id') id: string,
    @Body() body: TestAutomationDto,
  ) {
    await this.creator(req, databaseId);
    return this.automationsService.test(
      req.membership.workspaceId,
      databaseId,
      id,
      body.record_id,
      req.user.id,
      body.action_index,
    );
  }

  @Post(':id/regenerate-hook')
  @RequiresScope('write')
  @ApiOperation({
    summary: "Rotate a webhook_received rule's token + secret — the old URL 404s immediately",
  })
  async regenerateHook(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Param('id') id: string,
  ) {
    await this.creator(req, databaseId);
    return this.automationsService.regenerateHook(databaseId, id);
  }

  @Get(':id/last-payload')
  @RequiresScope('write')
  @ApiOperation({
    summary: 'The most recent payload a webhook_received rule received (for token mapping)',
  })
  async lastPayload(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Param('id') id: string,
  ) {
    await this.creator(req, databaseId);
    return this.automationsService.lastHookPayload(databaseId, id);
  }
}
