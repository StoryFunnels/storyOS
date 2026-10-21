import { Body, Controller, Delete, Get, Param, Put, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { AuthGuard } from '../auth/auth.guard';
import { WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import { ViewerStateService } from '../viewer-state/viewer-state.service';
import { collectionViewSchema } from '../viewer-state/viewer-state.kinds';

const setCollectionViewSchema = collectionViewSchema;
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
  constructor(private readonly viewerState: ViewerStateService) {}

  @Get()
  @ApiOperation({ summary: 'My personal view override for this embedded collection' })
  async get(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Param('field') fieldId: string,
  ) {
    const config = await this.viewerState.get(req.membership, 'collection_view', fieldId, databaseId);
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
    const config = await this.viewerState.set(req.membership, 'collection_view', fieldId, body, databaseId);
    return { config };
  }

  @Delete()
  @ApiOperation({ summary: 'Clear my personal override for this embedded collection (falls back to the shared default)' })
  async clear(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Param('field') fieldId: string,
  ) {
    await this.viewerState.clear(req.membership, 'collection_view', fieldId, databaseId);
    return { cleared: true };
  }
}
