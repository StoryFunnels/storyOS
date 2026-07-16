import {
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import { RequiresScope } from '../auth/token-scope.guard';
import {
  MinRole,
  WorkspaceAccessGuard,
} from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import { GdprService } from './gdpr.service';

/**
 * GDPR data-subject tooling (MN-233) — admin-only. `:member` is a workspace
 * membership id (same handle the members endpoints use).
 */
@ApiTags('gdpr')
@ApiBearerAuth()
@Controller('workspaces/:ws/members/:member/gdpr')
@UseGuards(AuthGuard, WorkspaceAccessGuard)
@MinRole('admin')
export class GdprController {
  constructor(private readonly gdpr: GdprService) {}

  @Get('export')
  @RequiresScope('admin')
  @ApiOperation({
    summary: 'Export everything held about this member (machine-readable JSON)',
  })
  export(@Req() req: WorkspaceRequest, @Param('member') member: string) {
    return this.gdpr.export(req.membership.workspaceId, member);
  }

  @Post('anonymize')
  @HttpCode(200)
  @RequiresScope('admin')
  @ApiOperation({
    summary:
      'Erase/anonymize this member: wipe identity to a tombstone, destroy ' +
      'credentials, and remove workspace access. Comments and history are kept.',
  })
  anonymize(@Req() req: WorkspaceRequest, @Param('member') member: string) {
    return this.gdpr.anonymize(req.membership.workspaceId, member);
  }
}
