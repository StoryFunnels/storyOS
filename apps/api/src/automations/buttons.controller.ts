import { Controller, Inject, NotFoundException, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { and, eq, isNull } from 'drizzle-orm';
import type { AutomationAction } from '@storyos/schemas';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { activityEvents, fields } from '../db/schema';
import { AuthGuard } from '../auth/auth.guard';
import { WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import { DatabasesService } from '../databases/databases.service';
import { RecordsService } from '../records/records.service';
import { AutomationActionsService } from './actions.service';

/** Button press (MN-046): runs the field's action list as the presser. */
@ApiTags('buttons')
@UseGuards(AuthGuard, WorkspaceAccessGuard)
@Controller('workspaces/:ws/databases/:db/records/:rec/buttons/:field')
export class ButtonsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly databases: DatabasesService,
    private readonly recordsService: RecordsService,
    private readonly actions: AutomationActionsService,
  ) {}

  @Post('press')
  @Throttle({ default: { limit: 10, ttl: 10_000 } })
  @ApiOperation({ summary: 'Press a button field (editor+); actions run as the presser' })
  async press(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Param('rec') recordId: string,
    @Param('field') fieldId: string,
  ) {
    await this.databases.assertAccess(req.membership, databaseId, 'editor');
    const field = await this.db.query.fields.findFirst({
      where: and(eq(fields.id, fieldId), eq(fields.databaseId, databaseId), isNull(fields.deletedAt)),
    });
    if (!field || field.type !== 'button') throw new NotFoundException('Button not found');
    const record = await this.recordsService.get(databaseId, recordId);

    const config = field.config as { actions: AutomationAction[] };
    const effects = await this.actions.execute(config.actions, {
      workspaceId: req.membership.workspaceId,
      databaseId,
      record,
      actorId: req.user.id,
    });

    await this.db.insert(activityEvents).values({
      workspaceId: req.membership.workspaceId,
      recordId,
      actorId: req.user.id,
      type: 'button.pressed',
      payload: { button: field.displayName, effects },
    });
    return { pressed: true, effects };
  }
}
