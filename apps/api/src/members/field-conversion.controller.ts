import { Body, Controller, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { RequiresScope } from '../auth/token-scope.guard';
import { DatabasesService } from '../databases/databases.service';
import { MinRole, WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import { FieldConversionService } from './field-conversion.service';

/** `dry_run` defaults to TRUE: nothing changes until the caller says so, after reading the plan (ADR-0012). */
const toMembersSchema = z.object({ dry_run: z.boolean().default(true) });
class ToMembersDto extends createZodDto(toMembersSchema) {}
const toUserSchema = z.object({
  dry_run: z.boolean().default(true),
  /** Required when removing the relation would also remove lookup/rollup fields built on it. */
  confirm_dependents: z.boolean().default(false),
});
class ToUserDto extends createZodDto(toUserSchema) {}

/**
 * #597 — guided conversion between a `user` field and a relation to the Members database. Admin-only:
 * it rewrites schema (including a field on the shared Members database) and bulk-writes links. Not marked
 * `@ResourceScopable`, so a token bound to specific spaces/databases (#543) cannot reach it.
 */
@ApiTags('fields')
@ApiBearerAuth()
@Controller('workspaces/:ws/databases/:db/fields/:field')
@UseGuards(AuthGuard, WorkspaceAccessGuard)
@RequiresScope('admin')
@MinRole('admin')
export class FieldConversionController {
  constructor(
    private readonly conversion: FieldConversionService,
    private readonly databases: DatabasesService,
  ) {}

  @Post('convert-to-members-relation')
  @ApiOperation({
    summary:
      'Convert a user field into a relation to the Members database. DRY RUN by default: reports matched/unresolvable counts, the per-role permission-neutrality proof, and what would be created. Applying keeps the original field (renamed) and parks anything unresolvable; nothing is dropped.',
  })
  async toMembers(@Req() req: WorkspaceRequest, @Param('db') databaseId: string, @Param('field') fieldId: string, @Body() body: ToMembersDto) {
    await this.databases.assertAccess(req.membership, databaseId, 'creator');
    return this.conversion.toMembersRelation(req.membership, req.user.id, databaseId, fieldId, body.dry_run);
  }

  @Post('convert-to-user')
  @ApiOperation({
    summary:
      'Convert a relation to the Members database back into a user field (the reverse). DRY RUN by default. Removes the relation and its Members-side inverse field; Members rows with no user id are parked in a text field.',
  })
  async toUser(@Req() req: WorkspaceRequest, @Param('db') databaseId: string, @Param('field') fieldId: string, @Body() body: ToUserDto) {
    await this.databases.assertAccess(req.membership, databaseId, 'creator');
    return this.conversion.toUserField(req.membership, req.user.id, databaseId, fieldId, body.dry_run, body.confirm_dependents);
  }
}
