import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import type { AuthedRequest } from '../auth/auth.guard';
import { MinRole, WorkspaceAccessGuard } from './workspace-access.guard';
import { RequiresScope } from '../auth/token-scope.guard';
import type { WorkspaceRequest } from './workspace-access.guard';
import {
  AcceptInviteDto,
  CreateInviteDto,
  CreateSpaceDto,
  CreateWorkspaceDto,
  UpdateMemberDto,
  UpdateSpaceDto,
  DeleteSpaceDto,
  UpdateWorkspaceDto,
} from './dto';
import { AccessService } from '../access/access.service';
import { InvitesService } from './invites.service';
import { MembersService } from './members.service';
import { SpacesService } from './spaces.service';
import { WorkspacesService } from './workspaces.service';

@ApiTags('workspaces')
@ApiBearerAuth()
@Controller('workspaces')
@UseGuards(AuthGuard)
export class WorkspacesController {
  constructor(private readonly workspaces: WorkspacesService) {}

  @Get()
  @ApiOperation({ summary: 'List workspaces I belong to' })
  list(@Req() req: AuthedRequest) {
    // #332: a workspace-scoped PAT (`via: 'token'`) can only address the
    // workspace it was minted for, so discovery must not list any other — a
    // full session/oauth credential (no `workspaceId`) still sees every
    // membership. Clamping here mirrors the per-request ceiling AuthGuard
    // already enforces for `:ws` routes.
    const scope = req.auth.via === 'token' ? req.auth.workspaceId : undefined;
    return this.workspaces.listForUser(req.user.id, scope);
  }

  @Post()
  @ApiOperation({ summary: 'Create a workspace (creator becomes admin)' })
  create(@Req() req: AuthedRequest, @Body() body: CreateWorkspaceDto) {
    return this.workspaces.create(req.user.id, body);
  }
}

@ApiTags('workspaces')
@ApiBearerAuth()
@Controller('workspaces/:ws')
@UseGuards(AuthGuard, WorkspaceAccessGuard)
export class WorkspaceController {
  constructor(
    private readonly workspaces: WorkspacesService,
    private readonly spaces: SpacesService,
    private readonly members: MembersService,
    private readonly invites: InvitesService,
    private readonly access: AccessService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Workspace details' })
  get(@Req() req: WorkspaceRequest) {
    return this.workspaces
      .listForUser(req.user.id)
      .then((all) => all.find((w) => w.id === req.membership.workspaceId));
  }

  @Patch()
  @MinRole('admin')
  @ApiOperation({ summary: 'Update workspace (admin)' })
  update(@Req() req: WorkspaceRequest, @Body() body: UpdateWorkspaceDto) {
    return this.workspaces.update(req.membership.workspaceId, body);
  }

  // --- Spaces ---

  @Get('spaces')
  @ApiOperation({ summary: 'List spaces (guests: scoped spaces only)' })
  listSpaces(@Req() req: WorkspaceRequest) {
    return this.spaces.list(req.membership);
  }

  @RequiresScope('admin')
  @Post('spaces')
  @MinRole('member')
  @ApiOperation({ summary: 'Create a space' })
  createSpace(@Req() req: WorkspaceRequest, @Body() body: CreateSpaceDto) {
    return this.spaces.create(req.membership.workspaceId, body);
  }

  /**
   * #520 — idempotent: the caller's OWN personal space, lazily provisioned on
   * first use. No @MinRole/@RequiresScope override — unlike creating a
   * shared space, this grants nothing beyond what every active membership
   * (including a guest) already implicitly has: a private area nobody else
   * can reach (personal-space.md §1).
   */
  @Post('spaces/personal')
  @ApiOperation({ summary: "Get or create the caller's personal space" })
  getOrCreatePersonalSpace(@Req() req: WorkspaceRequest) {
    return this.spaces.getOrCreatePersonal(req.membership.workspaceId, req.user.id);
  }

  @RequiresScope('admin')
  @Patch('spaces/:space')
  @MinRole('member')
  @ApiOperation({ summary: 'Rename/reorder a space' })
  updateSpace(
    @Req() req: WorkspaceRequest,
    @Param('space') spaceId: string,
    @Body() body: UpdateSpaceDto,
  ) {
    return this.spaces.update(req.membership.workspaceId, spaceId, body);
  }

  @RequiresScope('admin')
  @Delete('spaces/:space')
  // MN-124: deleting a space cascades every database and grant inside it. That
  // needs creator ON THIS SPACE (or admin) — `@MinRole('member')` asked nothing
  // about the scope, so the only friction was a confirm box.
  @ApiOperation({ summary: 'Delete a space (creator on this space, or admin)' })
  async deleteSpace(
    @Req() req: WorkspaceRequest,
    @Param('space') spaceId: string,
    @Body() body: DeleteSpaceDto,
  ) {
    await this.access.assertSpace(req.membership, spaceId, 'creator');
    // #417 — the typed-name guard is enforced in the service, so every caller
    // (HTTP, MCP, a script) meets it. See SpacesService.remove.
    return this.spaces.remove(req.membership.workspaceId, spaceId, { confirm: body?.confirm });
  }

  // --- Members ---

  @Get('members')
  @MinRole('member')
  @ApiOperation({ summary: 'List active members' })
  listMembers(@Req() req: WorkspaceRequest) {
    return this.members.list(req.membership.workspaceId);
  }

  @Patch('members/:member')
  @MinRole('admin')
  @ApiOperation({ summary: 'Change a member role / guest scoping (admin)' })
  updateMember(
    @Req() req: WorkspaceRequest,
    @Param('member') membershipId: string,
    @Body() body: UpdateMemberDto,
  ) {
    return this.members.update(req.membership.workspaceId, membershipId, body);
  }

  @Delete('members/:member')
  @MinRole('admin')
  @ApiOperation({ summary: 'Remove a member (admin)' })
  removeMember(@Req() req: WorkspaceRequest, @Param('member') membershipId: string) {
    return this.members.remove(req.membership.workspaceId, membershipId);
  }

  // --- Invites ---

  @Get('invites')
  @MinRole('admin')
  @ApiOperation({ summary: 'List pending invites (admin)' })
  listInvites(@Req() req: WorkspaceRequest) {
    return this.invites.listPending(req.membership.workspaceId);
  }

  @Post('invites')
  @MinRole('admin')
  @ApiOperation({ summary: 'Invite by email; guests require space_ids (admin)' })
  createInvite(@Req() req: WorkspaceRequest, @Body() body: CreateInviteDto) {
    return this.invites.create(req.membership.workspaceId, req.user.id, body);
  }

  @Post('invites/:invite/resend')
  @MinRole('admin')
  @ApiOperation({ summary: 'Resend a pending invite; returns a fresh link (admin)' })
  resendInvite(@Req() req: WorkspaceRequest, @Param('invite') inviteId: string) {
    return this.invites.resend(req.membership.workspaceId, inviteId);
  }

  @Delete('invites/:invite')
  @MinRole('admin')
  @ApiOperation({ summary: 'Revoke a pending invite (admin)' })
  revokeInvite(@Req() req: WorkspaceRequest, @Param('invite') inviteId: string) {
    return this.invites.revoke(req.membership.workspaceId, inviteId);
  }
}

@ApiTags('workspaces')
@ApiBearerAuth()
@Controller('invites')
@UseGuards(AuthGuard)
export class InviteAcceptController {
  constructor(private readonly invites: InvitesService) {}

  @Post('accept')
  @ApiOperation({ summary: 'Accept an invite by token (must match your email)' })
  accept(@Req() req: AuthedRequest, @Body() body: AcceptInviteDto) {
    return this.invites.accept(req.user, body.token);
  }
}
