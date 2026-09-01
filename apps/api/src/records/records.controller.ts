import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
  HttpCode,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  batchRecordIdsSchema,
  batchUpdateRecordsSchema,
  createRecordSchema,
  createRecordsBatchSchema,
  moveRecordSchema,
  queryRecordsSchema,
  updateRecordSchema,
  aggregateRecordsSchema,
} from '@storyos/schemas';
import { AuthGuard } from '../auth/auth.guard';
import { RequiresScope } from '../auth/token-scope.guard';
import { WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import { DatabasesService } from '../databases/databases.service';
import { RecordsService } from './records.service';

class CreateRecordDto extends createZodDto(createRecordSchema) {}
class CreateRecordsBatchDto extends createZodDto(createRecordsBatchSchema) {}
class UpdateRecordDto extends createZodDto(updateRecordSchema) {}
class BatchUpdateRecordsDto extends createZodDto(batchUpdateRecordsSchema) {}
class BatchRecordIdsDto extends createZodDto(batchRecordIdsSchema) {}
class QueryRecordsDto extends createZodDto(queryRecordsSchema) {}
class AggregateRecordsDto extends createZodDto(aggregateRecordsSchema) {}
class MoveRecordDto extends createZodDto(moveRecordSchema) {}

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
  q: z.string().optional(),
});
class ListRecordsQueryDto extends createZodDto(listQuerySchema) {}

@ApiTags('records')
@ApiBearerAuth()
@Controller('workspaces/:ws/databases/:db/records')
@UseGuards(AuthGuard, WorkspaceAccessGuard)
export class RecordsController {
  constructor(
    private readonly recordsService: RecordsService,
    private readonly databases: DatabasesService,
  ) {}

  /** Access-checked (ADR-0007): 404 without a grant, 403 below min. */
  private async assertDb(
    req: WorkspaceRequest,
    databaseId: string,
    min: 'viewer' | 'commenter' | 'contributor' | 'editor' | 'creator' = 'viewer',
  ) {
    await this.databases.assertAccess(req.membership, databaseId, min);
  }

  @Get()
  @ApiOperation({ summary: 'List records (manual order, optional q= title search, cursor)' })
  async list(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Query() query: ListRecordsQueryDto,
  ) {
    await this.assertDb(req, databaseId);
    return this.recordsService.list(databaseId, query, req.membership);
  }

  @Post()
  @ApiOperation({ summary: 'Create a record ({values} keyed by field api_name)' })
  async create(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Body() body: CreateRecordDto,
  ) {
    await this.assertDb(req, databaseId, 'contributor');
    return this.recordsService.create(
      req.membership.workspaceId,
      databaseId,
      body.values,
      req.user.id,
      0,
      req.auth?.source ?? 'human',
    );
  }

  @RequiresScope('read')
  @Post('query')
  @ApiOperation({ summary: 'Query records: filter AST + sorts + q + keyset cursor (the workhorse)' })
  async query(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Body() body: QueryRecordsDto,
  ) {
    await this.assertDb(req, databaseId);
    return this.recordsService.query(databaseId, body, req.user.id, req.membership);
  }

  /**
   * #404 — one number, computed in SQL.
   *
   * Sibling of `query` rather than a flag on it, because the two return
   * different SHAPES and a caller wanting a count should not have to ask for
   * rows and ignore them. Viewer access, same as reading: a count reveals
   * nothing a query would not.
   */
  @Post('aggregate')
  // A read, not a creation. Nest defaults POST to 201, which would tell every
  // client that a count made something.
  @HttpCode(200)
  @ApiOperation({ summary: 'Count or aggregate records server-side (same filter AST as /query)' })
  async aggregate(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Body() body: AggregateRecordsDto,
  ) {
    await this.assertDb(req, databaseId);
    return this.recordsService.aggregate(databaseId, body, req.user.id);
  }

  @Post('batch')
  @ApiOperation({ summary: 'Create up to 100 records atomically' })
  async createBatch(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Body() body: CreateRecordsBatchDto,
  ) {
    await this.assertDb(req, databaseId, 'contributor');
    const created = await this.recordsService.createBatch(
      req.membership.workspaceId,
      databaseId,
      body.records.map((r) => r.values),
      req.user.id,
      0,
      { source: req.auth?.source ?? 'human' },
    );
    return { data: created };
  }

  @Patch('batch')
  @ApiOperation({ summary: 'Apply one values patch to up to 200 records (partial failures reported)' })
  async batchUpdate(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Body() body: BatchUpdateRecordsDto,
  ) {
    await this.assertDb(req, databaseId, 'contributor');
    return this.recordsService.batchUpdate(
      req.membership.workspaceId,
      databaseId,
      body.record_ids,
      body.values,
      req.user.id,
      req.auth?.source ?? 'human',
    );
  }

  @Post('batch-delete')
  @ApiOperation({ summary: 'Soft-delete up to 200 records' })
  async batchDelete(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Body() body: BatchRecordIdsDto,
  ) {
    await this.assertDb(req, databaseId, 'editor');
    return this.recordsService.batchDelete(
      req.membership.workspaceId,
      databaseId,
      body.record_ids,
      req.user.id,
      req.auth?.source ?? 'human',
    );
  }

  @Post('batch-restore')
  @ApiOperation({ summary: 'Restore up to 200 records from trash' })
  async batchRestore(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Body() body: BatchRecordIdsDto,
  ) {
    await this.assertDb(req, databaseId, 'editor');
    return this.recordsService.batchRestore(
      req.membership.workspaceId,
      databaseId,
      body.record_ids,
      req.user.id,
      req.auth?.source ?? 'human',
    );
  }

  @Get('trash')
  @ApiOperation({ summary: 'Soft-deleted records (30-day retention)' })
  async trash(@Req() req: WorkspaceRequest, @Param('db') databaseId: string) {
    await this.assertDb(req, databaseId, 'editor');
    return { data: await this.recordsService.listTrash(databaseId) };
  }

  @Get('by-number/:number')
  @ApiOperation({ summary: 'Resolve a record by its public per-database number (MN-087)' })
  async getByNumber(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Param('number') number: string,
  ) {
    await this.assertDb(req, databaseId);
    const n = Number.parseInt(number, 10);
    if (!Number.isInteger(n)) throw new NotFoundException('Record not found');
    return this.recordsService.getByNumber(databaseId, n, req.membership);
  }

  @Get(':rec')
  @ApiOperation({ summary: 'Single record, values keyed by api_name' })
  async get(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Param('rec') recordId: string,
  ) {
    await this.assertDb(req, databaseId);
    return this.recordsService.get(databaseId, recordId, req.membership);
  }

  @Patch(':rec')
  @ApiOperation({ summary: 'Merge-update values (null clears a field)' })
  async update(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Param('rec') recordId: string,
    @Body() body: UpdateRecordDto,
  ) {
    await this.assertDb(req, databaseId, 'contributor');
    return this.recordsService.update(
      req.membership.workspaceId,
      databaseId,
      recordId,
      body.values,
      req.user.id,
      0,
      /*
       * #390 derived this inline from `auth.via`: token means MCP, session means
       * a person at a keyboard. Correct, but it could only ever say those two
       * things — and Tyron mints an ordinary PAT, so an AGENT write was
       * indistinguishable from a curl script's. #357 needs both "a person did
       * this" and "an agent generated it" to be recoverable.
       *
       * The derivation now lives in the auth guard, off the token ROW, so every
       * write site reads one answer instead of re-deriving a partial one. A
       * header would have been forgeable; provenance that can be claimed by its
       * holder is not provenance.
       *
       * Still deliberately imprecise in one direction, and still worth stating:
       * a PAT used by someone's own curl script lands as `mcp`. Both are "a
       * program wrote this, not a person typing", whereas pretending a scripted
       * write was human would be a lie in the direction that matters.
       */
      req.auth?.source ?? 'human',
    );
  }

  @Delete(':rec')
  @ApiOperation({ summary: 'Soft delete (restorable for 30 days)' })
  async remove(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Param('rec') recordId: string,
  ) {
    await this.assertDb(req, databaseId, 'editor');
    return this.recordsService.softDelete(
      req.membership.workspaceId,
      databaseId,
      recordId,
      req.user.id,
      0,
      req.auth?.source ?? 'human',
    );
  }

  @Post(':rec/duplicate')
  @ApiOperation({ summary: 'Duplicate: clone values + description + single/m2m links (not owned collections)' })
  async duplicate(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Param('rec') recordId: string,
  ) {
    await this.assertDb(req, databaseId, 'creator');
    return this.recordsService.duplicate(
      req.membership.workspaceId,
      databaseId,
      recordId,
      req.user.id,
      req.auth?.source ?? 'human',
    );
  }

  @Post(':rec/watch')
  @ApiOperation({ summary: 'Watch this record — get notified (inbox/email) on any change (#236)' })
  async watch(@Req() req: WorkspaceRequest, @Param('db') databaseId: string, @Param('rec') recordId: string) {
    await this.assertDb(req, databaseId); // if you can see it, you can watch it
    return this.recordsService.watch(req.membership.workspaceId, recordId, req.user.id);
  }

  @Delete(':rec/watch')
  @ApiOperation({ summary: 'Stop watching this record (#236)' })
  async unwatch(@Req() req: WorkspaceRequest, @Param('db') databaseId: string, @Param('rec') recordId: string) {
    await this.assertDb(req, databaseId);
    return this.recordsService.unwatch(recordId, req.user.id);
  }

  @Get(':rec/watchers')
  @ApiOperation({ summary: "List this record's watchers + whether I watch it (#236)" })
  async watchers(@Req() req: WorkspaceRequest, @Param('db') databaseId: string, @Param('rec') recordId: string) {
    await this.assertDb(req, databaseId);
    return this.recordsService.listWatchers(recordId, req.user.id);
  }

  @Post(':rec/move')
  @ApiOperation({ summary: 'Atomic move: fractional reposition + optional value patch (kanban drop)' })
  async move(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Param('rec') recordId: string,
    @Body() body: MoveRecordDto,
  ) {
    await this.assertDb(req, databaseId, 'contributor');
    return this.recordsService.move(
      req.membership.workspaceId,
      databaseId,
      recordId,
      body,
      req.user.id,
      req.auth?.source ?? 'human',
    );
  }

  @Post(':rec/restore')
  @ApiOperation({ summary: 'Restore from trash' })
  async restore(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Param('rec') recordId: string,
  ) {
    await this.assertDb(req, databaseId, 'editor');
    return this.recordsService.restore(
      req.membership.workspaceId,
      databaseId,
      recordId,
      req.user.id,
      req.auth?.source ?? 'human',
    );
  }
}
