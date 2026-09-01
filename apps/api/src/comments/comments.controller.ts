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
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import { DatabasesService } from '../databases/databases.service';
import { RecordsService } from '../records/records.service';
import { CommentsService } from './comments.service';
import type { CommentBody } from './comments.service';

const segmentSchema = z.union([
  z.object({ type: z.literal('text'), text: z.string().max(5000) }),
  z.object({ type: z.literal('mention'), user_id: z.string() }),
  // #record mention (#140) — validated against live workspace records server-side.
  z.object({ type: z.literal('record'), record_id: z.uuid(), database_id: z.uuid() }),
]);
/** New comments (#180): a BlockNote document, discriminated by `format` so it can
 *  never be confused with the legacy segment array. `doc` is opaque BlockNote JSON;
 *  its inline mention nodes are extracted + validated server-side like the legacy
 *  segments. Stored as-is (jsonb) — dual-format, no migration. */
const blocknoteBodySchema = z.object({
  format: z.literal('blocknote'),
  doc: z.array(z.record(z.string(), z.unknown())).min(1).max(500),
});
// Accept BOTH the legacy segment array and the new BlockNote shape.
const commentBodySchema = z.object({
  body: z.union([z.array(segmentSchema).min(1).max(200), blocknoteBodySchema]),
});
class CommentBodyDto extends createZodDto(commentBodySchema) {}

/**
 * Comments are the one WRITE guests are allowed (role matrix: guest = read +
 * comment) — hence no @MinRole here; record visibility is still enforced via
 * the database guest-scope check.
 */
@ApiTags('comments')
@ApiBearerAuth()
@Controller('workspaces/:ws/databases/:db/records/:rec/comments')
@UseGuards(AuthGuard, WorkspaceAccessGuard)
export class CommentsController {
  constructor(
    private readonly commentsService: CommentsService,
    private readonly databases: DatabasesService,
    private readonly records: RecordsService,
  ) {}

  private async assertRecord(
    req: WorkspaceRequest,
    databaseId: string,
    recordId: string,
    min: 'viewer' | 'commenter' = 'viewer',
  ) {
    await this.databases.assertAccess(req.membership, databaseId, min);
    await this.records.getRow(databaseId, recordId);
  }

  @Get()
  @ApiOperation({ summary: 'Comments, newest first' })
  async list(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Param('rec') recordId: string,
  ) {
    await this.assertRecord(req, databaseId, recordId);
    return this.commentsService.list(recordId);
  }

  @Post()
  @ApiOperation({ summary: 'Comment (guests included); mentions extracted server-side' })
  async create(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Param('rec') recordId: string,
    @Body() body: CommentBodyDto,
  ) {
    await this.assertRecord(req, databaseId, recordId, 'commenter');
    return this.commentsService.create(
      req.membership.workspaceId,
      recordId,
      body.body as CommentBody,
      req.user.id,
      req.auth?.source ?? 'human',
    );
  }

  @Patch(':comment')
  @ApiOperation({ summary: 'Edit own comment' })
  async update(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Param('rec') recordId: string,
    @Param('comment') commentId: string,
    @Body() body: CommentBodyDto,
  ) {
    await this.assertRecord(req, databaseId, recordId, 'commenter');
    return this.commentsService.update(
      recordId,
      commentId,
      body.body as CommentBody,
      req.user.id,
      req.membership.workspaceId,
    );
  }

  @Delete(':comment')
  @ApiOperation({ summary: 'Delete own comment (admins: any)' })
  async remove(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Param('rec') recordId: string,
    @Param('comment') commentId: string,
  ) {
    await this.assertRecord(req, databaseId, recordId, 'commenter');
    return this.commentsService.remove(
      recordId,
      commentId,
      req.user.id,
      req.membership.role === 'admin',
      req.membership.workspaceId,
    );
  }
}
