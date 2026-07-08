import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { createGrantSchema } from '@storyos/schemas';
import { AuthGuard } from '../auth/auth.guard';
import { MinRole, WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import { AccessService } from './access.service';

class CreateGrantDto extends createZodDto(createGrantSchema) {}

/** Admin-only grant management (ADR-0007) — the backend of the Share dialogs. */
@ApiTags('access')
@ApiBearerAuth()
@Controller('workspaces/:ws/grants')
@UseGuards(AuthGuard, WorkspaceAccessGuard)
@MinRole('admin')
export class GrantsController {
  constructor(private readonly access: AccessService) {}

  @Get()
  @ApiOperation({ summary: 'List access grants (optionally for one user)' })
  list(@Req() req: WorkspaceRequest, @Query('user_id') userId?: string) {
    return this.access.listGrants(req.membership.workspaceId, userId);
  }

  @Post()
  @ApiOperation({ summary: 'Grant a role on a space or database (upserts per scope)' })
  create(@Req() req: WorkspaceRequest, @Body() body: CreateGrantDto) {
    return this.access.createGrant(req.membership.workspaceId, body, req.user.id);
  }

  @Delete(':grant')
  @ApiOperation({ summary: 'Revoke a grant' })
  remove(@Req() req: WorkspaceRequest, @Param('grant') grantId: string) {
    return this.access.deleteGrant(req.membership.workspaceId, grantId);
  }
}
