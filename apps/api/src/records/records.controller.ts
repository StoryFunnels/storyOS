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
  createRecordSchema,
  createRecordsBatchSchema,
  moveRecordSchema,
  queryRecordsSchema,
  updateRecordSchema,
} from '@storyos/schemas';
import { AuthGuard } from '../auth/auth.guard';
import { MinRole, WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import { DatabasesService } from '../databases/databases.service';
import { RecordsService } from './records.service';

class CreateRecordDto extends createZodDto(createRecordSchema) {}
class CreateRecordsBatchDto extends createZodDto(createRecordsBatchSchema) {}
class UpdateRecordDto extends createZodDto(updateRecordSchema) {}
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

  /** Ensures :db belongs to :ws and the caller's guest scope. */
  private async assertDb(req: WorkspaceRequest, databaseId: string) {
    await this.databases.get(req.membership, databaseId);
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
  @MinRole('member')
  @ApiOperation({ summary: 'Create a record ({values} keyed by field api_name)' })
  async create(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Body() body: CreateRecordDto,
  ) {
    await this.assertDb(req, databaseId);
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
  @MinRole('member')
  @ApiOperation({ summary: 'Create up to 100 records atomically' })
  async createBatch(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Body() body: CreateRecordsBatchDto,
  ) {
    await this.assertDb(req, databaseId);
    const created = await this.recordsService.createBatch(
      req.membership.workspaceId,
      databaseId,
      body.records.map((r) => r.values),
      req.user.id,
    );
    return { data: created };
  }

  @Get('trash')
  @MinRole('member')
  @ApiOperation({ summary: 'Soft-deleted records (30-day retention)' })
  async trash(@Req() req: WorkspaceRequest, @Param('db') databaseId: string) {
    await this.assertDb(req, databaseId);
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
  @MinRole('member')
  @ApiOperation({ summary: 'Merge-update values (null clears a field)' })
  async update(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Param('rec') recordId: string,
    @Body() body: UpdateRecordDto,
  ) {
    await this.assertDb(req, databaseId);
    return this.recordsService.update(
      req.membership.workspaceId,
      databaseId,
      recordId,
      body.values,
      req.user.id,
    );
  }

  @Delete(':rec')
  @MinRole('member')
  @ApiOperation({ summary: 'Soft delete (restorable for 30 days)' })
  async remove(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Param('rec') recordId: string,
  ) {
    await this.assertDb(req, databaseId);
    return this.recordsService.softDelete(
      req.membership.workspaceId,
      databaseId,
      recordId,
      req.user.id,
    );
  }

  @Post(':rec/move')
  @MinRole('member')
  @ApiOperation({ summary: 'Atomic move: fractional reposition + optional value patch (kanban drop)' })
  async move(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Param('rec') recordId: string,
    @Body() body: MoveRecordDto,
  ) {
    await this.assertDb(req, databaseId);
    return this.recordsService.move(
      req.membership.workspaceId,
      databaseId,
      recordId,
      body,
      req.user.id,
    );
  }

  @Post(':rec/restore')
  @MinRole('member')
  @ApiOperation({ summary: 'Restore from trash' })
  async restore(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Param('rec') recordId: string,
  ) {
    await this.assertDb(req, databaseId);
    return this.recordsService.restore(
      req.membership.workspaceId,
      databaseId,
      recordId,
      req.user.id,
    );
  }
}
