import { Body, Controller, Delete, Get, Param, Put, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import { DatabasesService } from '../databases/databases.service';
import { PreferencesService } from '../users/preferences.service';

const collectionViewConditionSchema = z.object({
  field: z.string(),
  op: z.string(),
  value: z.unknown().optional(),
});

const collectionViewSortSchema = z.object({
  field: z.string(),
  direction: z.enum(['asc', 'desc']),
});

const setCollectionViewSchema = z.object({
  filters: z
    .union([
      z.object({ and: z.array(collectionViewConditionSchema) }),
      z.object({ or: z.array(collectionViewConditionSchema) }),
    ])
    .optional(),
  sorts: z.array(collectionViewSortSchema).max(3).optional(),
  sorts_nulls: z.enum(['first', 'last']).optional(),
  color_by: z.string().optional(),
  fields: z.array(z.string()).optional(),
});
class SetCollectionViewDto extends createZodDto(setCollectionViewSchema) {}

/**
 * Personal collection-view override (#736): narrows/sorts/colors an embedded
 * relation collection (apps/web's collection-section.tsx) for the CURRENT
 * viewer only. Never touches the field's own shared `config.collection_view`
 * — that stays the DEFAULT everyone without a personal override still sees.
 *
 * A SEPARATE controller from FieldsController, not another route on it, for
 * the exact reason PersonalFilterController is separate from ViewsController:
 * FieldsController is `@RequiresScope('admin')`-gated because a field IS
 * shared schema. A personal override isn't — any member who can see the
 * database may set their own, so this only needs the ordinary
 * workspace-membership + per-database viewer check.
 */
@ApiTags('fields')
@ApiBearerAuth()
@Controller('workspaces/:ws/databases/:db/fields/:field/personal-collection-view')
@UseGuards(AuthGuard, WorkspaceAccessGuard)
export class PersonalCollectionViewController {
  constructor(
    private readonly databases: DatabasesService,
    private readonly preferences: PreferencesService,
  ) {}

  private async assertViewer(req: WorkspaceRequest, databaseId: string) {
    await this.databases.assertAccess(req.membership, databaseId, 'viewer');
  }

  @Get()
  @ApiOperation({ summary: 'My personal view override for this embedded collection' })
  async get(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Param('field') fieldId: string,
  ) {
    await this.assertViewer(req, databaseId);
    const config = await this.preferences.getCollectionView(req.user.id, databaseId, fieldId);
    return { config: config ?? null };
  }

  @Put()
  @ApiOperation({ summary: 'Set (or replace) my personal view override for this embedded collection' })
  async set(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Param('field') fieldId: string,
    @Body() body: SetCollectionViewDto,
  ) {
    await this.assertViewer(req, databaseId);
    const config = await this.preferences.setCollectionView(req.user.id, databaseId, fieldId, body);
    return { config };
  }

  @Delete()
  @ApiOperation({ summary: 'Clear my personal override for this embedded collection (falls back to the shared default)' })
  async clear(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Param('field') fieldId: string,
  ) {
    await this.assertViewer(req, databaseId);
    await this.preferences.clearCollectionView(req.user.id, databaseId, fieldId);
    return { cleared: true };
  }
}
