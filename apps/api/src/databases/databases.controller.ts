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
    await this.databases.assertAccess(req.membership, databaseId, 'creator');
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
    return this.databases.remove(req.membership, databaseId, body.confirm, body.sever_relations);
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
