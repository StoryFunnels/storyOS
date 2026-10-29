import {
  ForbiddenException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ServerTimingInterceptor } from '../common/server-timing';
import { ResourceScopable } from '../access/resource-scope';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import {
  createDatabaseSchema,
  deleteDatabaseSchema,
  updateDatabaseSchema,
} from '@storyos/schemas';
import { AuthGuard } from '../auth/auth.guard';
import { RequiresScope } from '../auth/token-scope.guard';
import { MinRole, WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import { DatabasesService } from './databases.service';

class CreateDatabaseDto extends createZodDto(createDatabaseSchema) {}
class UpdateDatabaseDto extends createZodDto(updateDatabaseSchema) {}
class DeleteDatabaseDto extends createZodDto(deleteDatabaseSchema) {}

@ApiTags('databases')
@ApiBearerAuth()
@Controller('workspaces/:ws/databases')
@ResourceScopable()
@UseGuards(AuthGuard, WorkspaceAccessGuard)
export class DatabasesController {
  constructor(private readonly databases: DatabasesService) {}

  @Get()
  @ApiOperation({ summary: 'List databases (guests: scoped spaces only)' })
  list(@Req() req: WorkspaceRequest) {
    return this.databases.list(req.membership);
  }

  @RequiresScope('admin')
  @Post()
  @MinRole('member')
  @ApiOperation({ summary: 'Create a database (auto: title field, system fields, default view)' })
  create(@Req() req: WorkspaceRequest, @Body() body: CreateDatabaseDto) {
    return this.databases.create(req.membership, body);
  }

  // #37 — registered BEFORE ':db' below: a literal 'trash' segment must win
  // over the wildcard :db param route, or Nest would treat "trash" as a
  // database id and this would never be reached.
  @Get('trash')
  @MinRole('admin')
  @ApiOperation({ summary: 'Deleted databases in this workspace (admin)' })
  listTrash(@Req() req: WorkspaceRequest) {
    return this.databases.listTrash(req.membership.workspaceId);
  }

  @Get(':db')
  @UseInterceptors(ServerTimingInterceptor) // #1010 — Server-Timing: database time + statement count, timings only
  @ApiOperation({ summary: 'Database with live fields and views (schema introspection)' })
  get(@Req() req: WorkspaceRequest, @Param('db') databaseId: string) {
    return this.databases.get(req.membership, databaseId);
  }

  @RequiresScope('admin')
  @Patch(':db')
  @ApiOperation({ summary: 'Rename / re-icon (creator); moving between spaces stays member+' })
  async update(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Body() body: UpdateDatabaseDto,
  ) {
    // Moving a database between spaces is a workspace-structure change, not a
    // database-content one — a guest with a creator grant on this database still
    // must not re-parent it into a space they can't see.
    if (body.space_id !== undefined || body.position !== undefined) {
      await this.databases.assertCanMove(req.membership, body.space_id);
    }
    // ticket #1098 — access FIRST: a caller who cannot see the database is told it is not there (404, ADR-0018 (b)), and only someone
    // who can see it is told, below, that sharing is an admin decision. Asked the other way round a 403 named a database the
    // caller was not allowed to know about.
    await this.databases.assertAccess(req.membership, databaseId, 'creator');
    // #943 — who a database is shared with is an admin decision (ADR-0018 §6), even for someone holding creator on it.
    if (body.restricted !== undefined && req.membership.role !== 'admin') {
      throw new ForbiddenException('Only an admin can change who a database is shared with');
    }
    return this.databases.update(req.membership, databaseId, body);
  }

  // MN-124: creator ON THIS DATABASE, or admin. It was `@MinRole('member')` with
  // only a typed-name confirm — that is UX friction, not authorization. Note it
  // now matches rename (:67), which already required creator: destroying can no
  // longer be easier than renaming.
  @RequiresScope('admin')
  @Delete(':db')
  @ApiOperation({ summary: 'Hard delete (creator on this database, or admin) — body.confirm must equal the name' })
  async remove(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Body() body: DeleteDatabaseDto,
  ) {
    await this.databases.assertAccess(req.membership, databaseId, 'creator');
    return this.databases.remove(
      req.membership,
      databaseId,
      body.confirm,
      body.sever_relations,
      req.user.id,
      req.auth?.source ?? 'human',
    );
  }

  // #37 — admin-only: the bug this ticket fixes is literally "an admin
  // cannot restore", and a soft-deleted database has no live grants context
  // to run the usual graded access ladder against (assertAccess's own lookup
  // filters deletedAt IS NULL, same as every other read path), so this does
  // not attempt to reuse it.
  @RequiresScope('admin')
  @Post(':db/restore')
  @MinRole('admin')
  @ApiOperation({ summary: 'Restore a deleted database, and whatever fields/records/views were deleted with it (admin)' })
  restore(@Req() req: WorkspaceRequest, @Param('db') databaseId: string) {
    return this.databases.restore(req.membership.workspaceId, databaseId);
  }
}
