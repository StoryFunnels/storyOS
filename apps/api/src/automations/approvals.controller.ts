import { Body, Controller, ForbiddenException, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { RequiresScope } from '../auth/token-scope.guard';
import { WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import { ApprovalsService } from './approvals.service';

class RejectApprovalDto extends createZodDto(z.object({ reason: z.string().max(2000).optional() })) {}

/**
 * MN-255 — the approval gate's REST surface. Read is any workspace member
 * (`@RequiresScope('read')`); approve/reject are human-only: a PAT needs
 * `admin` scope to get past AuthGuard at all (`@RequiresScope('admin')`),
 * and — for BOTH a session and a PAT — `assertHuman` below additionally
 * requires the caller be the approval's own approver or a workspace admin.
 * AuthGuard only enforces token scope for `via: 'token'` requests (see its
 * own doc), so a session caller is never blocked by the decorator, only by
 * `assertHuman`; that's the "session or admin PAT, not member PAT" split the
 * ticket asks for without overloading the scope decorator to express it.
 */
@ApiTags('approvals')
@UseGuards(AuthGuard, WorkspaceAccessGuard)
@Controller('workspaces/:ws/approvals')
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Get()
  @RequiresScope('read')
  @ApiOperation({ summary: 'List approvals for this workspace, optionally filtered by status' })
  list(@Req() req: WorkspaceRequest, @Query('status') status?: string) {
    return this.approvals.list(req.membership.workspaceId, status);
  }

  @Post(':id/approve')
  @RequiresScope('admin')
  @ApiOperation({ summary: "Approve a pending approval — enqueues the gated action from its frozen snapshot (human-only)" })
  async approve(@Req() req: WorkspaceRequest, @Param('id') id: string) {
    await this.assertHuman(req, id);
    return this.approvals.approve(req.membership.workspaceId, id, req.user.id);
  }

  @Post(':id/reject')
  @RequiresScope('admin')
  @ApiOperation({ summary: 'Reject a pending approval — the gated action never runs (human-only)' })
  async reject(@Req() req: WorkspaceRequest, @Param('id') id: string, @Body() body: RejectApprovalDto) {
    await this.assertHuman(req, id);
    return this.approvals.reject(req.membership.workspaceId, id, req.user.id, body.reason);
  }

  private async assertHuman(req: WorkspaceRequest, id: string): Promise<void> {
    const approval = await this.approvals.get(req.membership.workspaceId, id);
    const isAdmin = req.membership.role === 'admin';
    const isApprover = approval.approverId === req.user.id;
    if (!isAdmin && !isApprover) {
      throw new ForbiddenException("Only this approval's approver or a workspace admin can decide it");
    }
  }
}
