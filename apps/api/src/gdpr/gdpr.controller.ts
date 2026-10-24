import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import type { AuthedRequest } from '../auth/auth.guard';
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
      'Erase this member FROM THIS WORKSPACE: remove their membership, access and per-person state here and the tokens minted for it. ' +
      'Their global identity and every other workspace are untouched (#1039); that is /me/gdpr/erase, self-service. Comments and history are kept.',
  })
  anonymize(@Req() req: WorkspaceRequest, @Param('member') member: string) {
    return this.gdpr.anonymize(req.membership.workspaceId, member);
  }
}

class EraseMyIdentityDto extends createZodDto(z.object({ confirm: z.literal(true) })) {}

/**
 * #1039 — erase YOUR OWN global identity: the account becomes a tombstone, every credential, session, token and OAuth connection is
 * destroyed, and you leave every workspace. Self-service and session-only: it is the person's own identity, not something a workspace
 * admin, an API token or an AI connection may do for them. Refused (409) while you are the only admin of a workspace.
 */
@ApiTags('gdpr')
@ApiBearerAuth()
@Controller('me/gdpr')
@UseGuards(AuthGuard)
export class GdprSelfController {
  constructor(private readonly gdpr: GdprService) {}

  @Post('erase')
  @HttpCode(200)
  @ApiOperation({ summary: 'Erase my own account everywhere (irreversible; body {"confirm": true}); session only' })
  erase(@Req() req: AuthedRequest, @Body() _body: EraseMyIdentityDto) {
    if (req.auth?.via !== 'session') {
      throw new ForbiddenException('Sign in as yourself to erase your account: an API token or an AI connection cannot do this');
    }
    return this.gdpr.eraseGlobalIdentity(req.user.id);
  }
}
