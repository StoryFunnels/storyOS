import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
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
} from '@storyos/schemas';
import { AuthGuard } from '../auth/auth.guard';
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
    min: 'viewer' | 'commenter' | 'editor' | 'creator' = 'viewer',
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
    return this.recordsService.list(databaseId, query);
  }

  @Post()
  @ApiOperation({ summary: 'Create a record ({values} keyed by field api_name)' })
  async create(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Body() body: CreateRecordDto,
  ) {
    await this.assertDb(req, databaseId, 'editor');
    return this.recordsService.create(
      req.membership.workspaceId,
      databaseId,
      body.values,
      req.user.id,
    );
  }

  @Post('query')
  @ApiOperation({ summary: 'Query records: filter AST + sorts + q + keyset cursor (the workhorse)' })
  async query(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Body() body: QueryRecordsDto,
  ) {
    await this.assertDb(req, databaseId);
    return this.recordsService.query(databaseId, body, req.user.id);
  }

  @Post('batch')
  @ApiOperation({ summary: 'Create up to 100 records atomically' })
  async createBatch(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Body() body: CreateRecordsBatchDto,
  ) {
    await this.assertDb(req, databaseId, 'editor');
    const created = await this.recordsService.createBatch(
      req.membership.workspaceId,
      databaseId,
      body.records.map((r) => r.values),
      req.user.id,
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
    await this.assertDb(req, databaseId, 'editor');
    return this.recordsService.batchUpdate(
      req.membership.workspaceId,
      databaseId,
      body.record_ids,
      body.values,
      req.user.id,
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
    return this.recordsService.batchDelete(req.membership.workspaceId, databaseId, body.record_ids, req.user.id);
  }

  @Post('batch-restore')
  @ApiOperation({ summary: 'Restore up to 200 records from trash' })
  async batchRestore(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Body() body: BatchRecordIdsDto,
  ) {
    await this.assertDb(req, databaseId, 'editor');
    return this.recordsService.batchRestore(req.membership.workspaceId, databaseId, body.record_ids, req.user.id);
  }

  @Get('trash')
  @ApiOperation({ summary: 'Soft-deleted records (30-day retention)' })
  async trash(@Req() req: WorkspaceRequest, @Param('db') databaseId: string) {
    await this.assertDb(req, databaseId, 'editor');
    return { data: await this.recordsService.listTrash(databaseId) };
  }

  @Get(':rec')
  @ApiOperation({ summary: 'Single record, values keyed by api_name' })
  async get(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Param('rec') recordId: string,
  ) {
    await this.assertDb(req, databaseId);
    return this.recordsService.get(databaseId, recordId);
  }

  @Patch(':rec')
  @ApiOperation({ summary: 'Merge-update values (null clears a field)' })
  async update(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Param('rec') recordId: string,
    @Body() body: UpdateRecordDto,
  ) {
    await this.assertDb(req, databaseId, 'editor');
    return this.recordsService.update(
      req.membership.workspaceId,
      databaseId,
      recordId,
      body.values,
      req.user.id,
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
    );
  }

  @Post(':rec/move')
  @ApiOperation({ summary: 'Atomic move: fractional reposition + optional value patch (kanban drop)' })
  async move(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Param('rec') recordId: string,
    @Body() body: MoveRecordDto,
  ) {
    await this.assertDb(req, databaseId, 'editor');
    return this.recordsService.move(
      req.membership.workspaceId,
      databaseId,
      recordId,
      body,
      req.user.id,
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
    );
  }
}
