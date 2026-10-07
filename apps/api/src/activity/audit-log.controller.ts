import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { MinRole, WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import { AuditLogService } from './audit-log.service';

const auditLogQuerySchema = z.object({
  actor: z.string().optional(),
  entity: z.uuid().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});
class AuditLogQueryDto extends createZodDto(auditLogQuerySchema) {}

/**
 * #454 — workspace-wide "who changed or deleted what, and when." Admin-only
 * (AC: "a non-admin member cannot reach the audit view or its API"), reading
 * ONLY the existing activity_events/record_field_changes tables — no second
 * event stream. See audit-log.service.ts's own doc comment for the stated,
 * known gap: structural (database/view/space) deletions aren't in scope of
 * what these tables can answer yet.
 */
@ApiTags('activity')
@ApiBearerAuth()
@Controller('workspaces/:ws/audit-log')
@UseGuards(AuthGuard, WorkspaceAccessGuard)
@MinRole('admin')
export class AuditLogController {
  constructor(private readonly auditLog: AuditLogService) {}

  @Get()
  @ApiOperation({ summary: 'Workspace-wide activity + field changes, filterable by actor/entity/date range (admin)' })
  list(@Req() req: WorkspaceRequest, @Query() query: AuditLogQueryDto) {
    return this.auditLog.list(req.membership.workspaceId, query);
  }
}
