import { Controller, Get, Inject, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { databases, packInstalls, relations, views } from '../db/schema';
import { ActivationService } from './activation.service';
import { AuthGuard } from '../auth/auth.guard';
import { WorkspaceAccessGuard } from './workspace-access.guard';
import type { WorkspaceRequest } from './workspace-access.guard';

/**
 * MN-213 (#139): the Getting Started checklist derives each step from REAL
 * workspace state, computed live — never a stored flag that drifts. A checklist
 * that tells an activated user they haven't done things they have reads as
 * broken on the very first screen.
 */
@ApiTags('workspaces')
@ApiBearerAuth()
@Controller('workspaces/:ws')
@UseGuards(AuthGuard, WorkspaceAccessGuard)
export class OnboardingController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly activation: ActivationService,
  ) {}

  private async exists(query: Promise<Array<unknown>>): Promise<boolean> {
    return (await query).length > 0;
  }

  @Get('onboarding')
  @ApiOperation({ summary: 'Live Getting-Started state, derived from what actually exists (MN-213)' })
  async onboarding(@Req() req: WorkspaceRequest) {
    const workspaceId = req.membership.workspaceId;

    // #128: system databases (Members, and the Agentic OS pack) are provisioned
    // FOR the user, not BY them — they must not light up "create a database" or
    // "add a record" on an otherwise-empty workspace.
    // #317: by flag, not by name — a user who names their first real database
    // "Agents" has genuinely created a database and the checklist must say so.
    const notSystemDatabase = eq(databases.isSystem, false);

    const [
      database_created,
      board_view_built,
      relation_created,
      business_pack_installed,
      { records_added, teammate_invited, ai_connected },
    ] = await Promise.all([
        this.exists(
          this.db
            .select({ one: sql`1` })
            .from(databases)
            .where(and(eq(databases.workspaceId, workspaceId), notSystemDatabase))
            .limit(1),
        ),
        this.exists(
          this.db
            .select({ one: sql`1` })
            .from(views)
            .innerJoin(databases, eq(databases.id, views.databaseId))
            .where(
              and(
                eq(databases.workspaceId, workspaceId),
                inArray(views.type, ['board', 'calendar', 'timeline', 'gallery']),
              ),
            )
            .limit(1),
        ),
        this.exists(
          this.db.select({ one: sql`1` }).from(relations).where(eq(relations.workspaceId, workspaceId)).limit(1),
        ),
        // "Install a Business Pack" (MN-219 / #161): any tracked install still
        // standing — an uninstalled pack no longer counts, the same way a
        // sample record stops counting once its template is removed.
        this.exists(
          this.db
            .select({ one: sql`1` })
            .from(packInstalls)
            .where(and(eq(packInstalls.workspaceId, workspaceId), isNull(packInstalls.uninstalledAt)))
            .limit(1),
        ),
        // records_added / teammate_invited / ai_connected: one shared definition (#817).
        this.activation.evaluate(workspaceId),
      ]);

    return {
      database_created,
      records_added,
      teammate_invited,
      board_view_built,
      relation_created,
      ai_connected,
      business_pack_installed,
    };
  }
}
