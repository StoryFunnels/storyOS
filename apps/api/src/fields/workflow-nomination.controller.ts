import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { applyWorkflowNominationSchema } from '@storyos/schemas';
import { AuthGuard } from '../auth/auth.guard';
import { RequiresScope } from '../auth/token-scope.guard';
import { WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import { WorkflowNominationService } from './workflow-nomination.service';

class ApplyWorkflowNominationDto extends createZodDto(applyWorkflowNominationSchema) {}

@ApiTags('fields')
@ApiBearerAuth()
@Controller('workspaces/:ws/workflow-nomination')
@UseGuards(AuthGuard, WorkspaceAccessGuard)
export class WorkflowNominationController {
  constructor(private readonly nomination: WorkflowNominationService) {}

  @Get()
  @RequiresScope('read')
  @ApiOperation({
    summary:
      'Scan every readable database for a select that looks like its lifecycle (status) field, and say which databases already have a workflow field. Read-only.',
  })
  scan(@Req() req: WorkspaceRequest) {
    return this.nomination.scan(req.membership);
  }

  @Post()
  @RequiresScope('admin')
  @ApiOperation({
    summary:
      'Convert chosen selects to the Workflow field type through the existing per-field conversion. DRY RUN by default (dry_run: false to apply); needs creator on each database; per-item results, one refusal does not stop the rest.',
  })
  apply(@Req() req: WorkspaceRequest, @Body() body: ApplyWorkflowNominationDto) {
    return this.nomination.apply(req.membership, body);
  }
}
