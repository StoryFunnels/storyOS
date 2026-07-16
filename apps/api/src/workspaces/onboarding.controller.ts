import { Controller, Get, Inject, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { and, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import {
  apiTokens,
  databases,
  invites,
  memberships,
  records,
  relations,
  views,
  workspaces,
} from '../db/schema';
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
  constructor(@Inject(DB) private readonly db: Db) {}

  private async exists(query: Promise<Array<unknown>>): Promise<boolean> {
    return (await query).length > 0;
  }

  @Get('onboarding')
  @ApiOperation({ summary: 'Live Getting-Started state, derived from what actually exists (MN-213)' })
  async onboarding(@Req() req: WorkspaceRequest) {
    const workspaceId = req.membership.workspaceId;

    // Sample records (installed by a template) don't count as "added records".
    const ws = await this.db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
    const sampleIds =
      ((ws?.settings ?? {}) as { sample_record_ids?: string[] }).sample_record_ids ?? [];

    const [database_created, records_added, teammate_invited, board_view_built, relation_created, ai_connected] =
      await Promise.all([
        this.exists(
          this.db.select({ one: sql`1` }).from(databases).where(eq(databases.workspaceId, workspaceId)).limit(1),
        ),
        this.exists(
          this.db
            .select({ one: sql`1` })
            .from(records)
            .innerJoin(databases, eq(databases.id, records.databaseId))
            .where(
              and(
                eq(databases.workspaceId, workspaceId),
                isNull(records.deletedAt),
                ...(sampleIds.length ? [notInArray(records.id, sampleIds)] : []),
              ),
            )
            .limit(1),
        ),
        (async () => {
          const activeMembers = await this.db
            .select({ one: sql`1` })
            .from(memberships)
            .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.status, 'active')))
            .limit(2);
          if (activeMembers.length > 1) return true;
          return this.exists(
            this.db
              .select({ one: sql`1` })
              .from(invites)
              .where(and(eq(invites.workspaceId, workspaceId), isNull(invites.acceptedAt)))
              .limit(1),
          );
        })(),
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
        // "Connect your AI": a PAT exists for this workspace — the MCP on-ramp.
        this.exists(
          this.db.select({ one: sql`1` }).from(apiTokens).where(eq(apiTokens.workspaceId, workspaceId)).limit(1),
        ),
      ]);

    return {
      database_created,
      records_added,
      teammate_invited,
      board_view_built,
      relation_created,
      ai_connected,
    };
  }
}
