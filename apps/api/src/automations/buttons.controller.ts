import { Controller, Inject, NotFoundException, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { AutomationAction } from '@storyos/schemas';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { activityEvents } from '../db/schema';
import { findFieldByRef } from '../fields/field-ref';
import { AuthGuard } from '../auth/auth.guard';
import { WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import { RunButtonRoute } from '../auth/token-scope.guard';
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

  @RunButtonRoute()
  @Post('press')
  @ApiParam({
    name: 'field',
    description:
      'The button field, by api_name or by id (#458 — same resolver as the links routes; an unrecognised field is a 404, never a 500).',
  })
  @Throttle({ default: { limit: 10, ttl: 10_000 } })
  @ApiOperation({ summary: 'Press a button field (editor+); actions run as the presser' })
  async press(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Param('rec') recordId: string,
    /** #458 — the button's id OR its api_name; same resolver the links routes use. */
    @Param('field') fieldRef: string,
  ) {
    await this.databases.assertAccess(req.membership, databaseId, 'editor');
    // #458 — this route had the identical raw-param-into-uuid-column shape as
    // the links routes, so an api_name (or any non-uuid) crashed with 22P02
    // rather than reaching the NotFoundException below. Fixed here in the same
    // change, through the same helper, rather than left to be found later.
    const field = await findFieldByRef(this.db, databaseId, fieldRef);
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
