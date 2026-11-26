import { Body, Controller, Get, HttpCode, Param, Post, Req, UnprocessableEntityException, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { RequiresScope } from '../auth/token-scope.guard';
import { RecordsService } from '../records/records.service';
import { WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import { SocialPublishesService } from './social-publishes.service';

/**
 * A retry takes no input: it re-queues the original post with its original named account. The two keys are declared
 * only so that a caller trying to pick a DIFFERENT account gets a clear refusal rather than having it silently ignored.
 */
class RetrySocialPublishDto extends createZodDto(
  z.object({ account_id: z.unknown().optional(), connection_id: z.unknown().optional() }),
) {}

/**
 * Ticket #42 — what a record's posts to LinkedIn and X did, and the retry of a failed one. Access is the record's:
 * whoever can read the record reads this, and retrying needs edit on the record (the connection is the workspace's).
 */
@ApiTags('social-publishes')
@ApiBearerAuth()
@UseGuards(AuthGuard, WorkspaceAccessGuard)
@Controller('workspaces/:ws/databases/:db/records/:rec/social-publishes')
export class SocialPublishesController {
  constructor(
    private readonly publishes: SocialPublishesService,
    private readonly records: RecordsService,
  ) {}

  @Get()
  @RequiresScope('read')
  @ApiOperation({
    summary:
      "What this record's posts to LinkedIn and X did, one entry per channel (latest outcome): waiting for approval, sent back, queued or retrying, published (with the post URL) or failed (with a safe code and sentence, never the network's own response).",
  })
  async list(@Req() req: WorkspaceRequest, @Param('db') databaseId: string, @Param('rec') recordId: string) {
    await this.records.assertRecordAccess(req.membership, databaseId, recordId, 'viewer');
    // can_retry is computed for THIS caller, so a viewer is never shown a button that would 403.
    const canEdit = await this.records
      .assertRecordAccess(req.membership, databaseId, recordId, 'editor')
      .then(() => true)
      .catch(() => false);
    return this.publishes.list(req.membership.workspaceId, databaseId, recordId, canEdit);
  }

  @Post(':publish/retry')
  @HttpCode(202)
  @RequiresScope('admin')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary:
      'Try a failed post again with its ORIGINAL account and approved text (no re-pick, no second approval). 409 when the post already went out, is in flight, was superseded, or hit the retry cap; 422 when it names no account.',
  })
  async retry(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Param('rec') recordId: string,
    @Param('publish') publishId: string,
    @Body() body: RetrySocialPublishDto,
  ) {
    await this.records.assertRecordAccess(req.membership, databaseId, recordId, 'editor');
    if (body.account_id !== undefined || body.connection_id !== undefined) {
      throw new UnprocessableEntityException(
        'A retry posts from the account the post was approved for. To post from another account, change the rule and run it again so it is approved again.',
      );
    }
    return this.publishes.retry(req.membership.workspaceId, databaseId, recordId, publishId);
  }
}
