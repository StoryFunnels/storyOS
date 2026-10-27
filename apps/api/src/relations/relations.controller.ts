import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { BOUNDARY_REFUSAL, ResourceScopable } from '../access/resource-scope';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import {
  createRelationSchema,
  deleteRelationSchema,
  linkRecordsSchema,
  replaceLinksSchema,
  selectDriftReconcileSchema,
  updateRelationSchema,
} from '@storyos/schemas';
import { AuthGuard } from '../auth/auth.guard';
import { RequiresScope } from '../auth/token-scope.guard';
import { WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import type { EffectiveRole } from '../access/access.service';
import { DatabasesService } from '../databases/databases.service';
import { RecordsService } from '../records/records.service';
import { RelationsService } from './relations.service';
import { AutoLinkService } from './auto-link.service';
import { SelectRelationDriftService } from './select-relation-drift.service';

class CreateRelationDto extends createZodDto(createRelationSchema) {}
class DeleteRelationDto extends createZodDto(deleteRelationSchema) {}
class UpdateRelationDto extends createZodDto(updateRelationSchema) {}
class LinkRecordsDto extends createZodDto(linkRecordsSchema) {}
class ReplaceLinksDto extends createZodDto(replaceLinksSchema) {}
class SelectDriftReconcileDto extends createZodDto(selectDriftReconcileSchema) {}

@ApiTags('relations')
@ApiBearerAuth()
@Controller('workspaces/:ws/relations')
@ResourceScopable()
@UseGuards(AuthGuard, WorkspaceAccessGuard)
@RequiresScope('admin')
export class RelationsController {
  constructor(
    private readonly relationsService: RelationsService,
    private readonly autoLinkService: AutoLinkService,
    private readonly selectDriftService: SelectRelationDriftService,
    private readonly databases: DatabasesService,
  ) {}

  /**
   * ticket #1101 — the ONE way a route keyed by a relation id loads it. A relation is reachable only through the two databases it joins,
   * so a caller who cannot read either of them gets exactly the answer for a relation that does not exist ("Relation not found"), not
   * "Database not found" (which says the relation exists and names what it touches). A token bound to spaces/databases (#543) gets its
   * boundary refusal for a missing relation too, as it does for a missing database: that refusal is promised to be identical whether the
   * target exists or not. Both databases are checked for visibility BEFORE either is checked for rank, so a "you need more access" 403
   * never confirms a relation whose other end the caller cannot see.
   */
  private async reachRelation(req: WorkspaceRequest, relationId: string, min: EffectiveRole) {
    let relation;
    try {
      relation = await this.relationsService.getRelation(req.membership.workspaceId, relationId);
    } catch (e) {
      if (e instanceof NotFoundException && req.membership.bound) throw new ForbiddenException(BOUNDARY_REFUSAL);
      throw e;
    }
    for (const rank of min === 'viewer' ? (['viewer'] as const) : (['viewer', min] as const)) {
      for (const databaseId of [relation.databaseAId, relation.databaseBId]) {
        try {
          await this.databases.assertAccess(req.membership, databaseId, rank);
        } catch (e) {
          if (e instanceof NotFoundException) throw new NotFoundException('Relation not found');
          throw e;
        }
      }
    }
    return relation;
  }

  @Post()
  @ApiOperation({ summary: 'Create a relation — needs creator on BOTH databases' })
  async create(@Req() req: WorkspaceRequest, @Body() body: CreateRelationDto) {
    await this.databases.assertAccess(req.membership, body.database_a_id, 'creator');
    await this.databases.assertAccess(req.membership, body.database_b_id, 'creator');
    return this.relationsService.create(req.membership, body);
  }

  /**
   * #448 — the graph in one call.
   *
   * Deliberately NOT `@RequiresScope`-relaxed: the class is admin-scoped and
   * this inherits that. The per-viewer filtering inside is about DATABASE
   * access, which is a different axis — an admin-scoped token still only sees
   * relations whose both ends its holder can read.
   */
  @Get()
  @ApiOperation({ summary: 'Every relation in the workspace — one entry per relation, both sides resolved (#448)' })
  async list(
    @Req() req: WorkspaceRequest,
    @Query('space') space?: string,
    @Query('database') database?: string,
  ) {
    return this.relationsService.listRelations(req.membership, {
      ...(space ? { spaceId: space } : {}),
      ...(database ? { databaseId: database } : {}),
    });
  }

  @Get(':rel')
  @ApiOperation({ summary: 'Relation config + comparable fields for the auto-link editor' })
  async detail(@Req() req: WorkspaceRequest, @Param('rel') relationId: string) {
    await this.reachRelation(req, relationId, 'viewer');
    return this.relationsService.getRelationDetail(req.membership.workspaceId, relationId);
  }

  @Patch(':rel')
  @ApiOperation({ summary: 'Set or clear a relation’s auto-link rules (MN-085)' })
  async update(
    @Req() req: WorkspaceRequest,
    @Param('rel') relationId: string,
    @Body() body: UpdateRelationDto,
  ) {
    await this.reachRelation(req, relationId, 'creator');
    return this.relationsService.setAutoLink(req.membership.workspaceId, relationId, body.auto_link);
  }

  @Post(':rel/auto-link')
  @ApiOperation({ summary: 'Run auto-link now across existing records — returns a summary (MN-085)' })
  async runAutoLink(@Req() req: WorkspaceRequest, @Param('rel') relationId: string) {
    await this.reachRelation(req, relationId, 'editor');
    return this.autoLinkService.runAutoLink(req.membership.workspaceId, relationId, req.user.id);
  }

  @Get(':rel/select-drift')
  @RequiresScope('read')
  @ApiOperation({
    summary:
      'Detect select↔relation drift for a parent record (MN-286): child records whose select-field ' +
      'label matches the parent’s title but aren’t linked here',
  })
  async selectDrift(
    @Req() req: WorkspaceRequest,
    @Param('rel') relationId: string,
    @Query('record_id') recordId?: string,
  ) {
    if (!recordId) throw new BadRequestException('record_id query param is required');
    await this.reachRelation(req, relationId, 'viewer');
    return this.selectDriftService.checkDrift(req.membership.workspaceId, relationId, recordId);
  }

  @Post(':rel/select-drift/reconcile')
  @RequiresScope('write')
  @ApiOperation({ summary: 'Bulk-link every currently-drifted child record to the parent (MN-286)' })
  async reconcileSelectDrift(
    @Req() req: WorkspaceRequest,
    @Param('rel') relationId: string,
    @Body() body: SelectDriftReconcileDto,
  ) {
    await this.reachRelation(req, relationId, 'editor');
    return this.selectDriftService.reconcile(
      req.membership.workspaceId,
      relationId,
      body.record_id,
      req.user.id,
    );
  }

  @Delete(':rel')
  @ApiOperation({ summary: 'Delete a relation, both its fields, and all links (confirm: true)' })
  async remove(
    @Req() req: WorkspaceRequest,
    @Param('rel') relationId: string,
    @Body() _body: DeleteRelationDto,
  ) {
    await this.reachRelation(req, relationId, 'creator');
    return this.relationsService.remove(req.membership.workspaceId, relationId);
  }
}

@ApiTags('relations')
@ApiBearerAuth()
@Controller('workspaces/:ws/databases/:db/records/:rec/links/:field')
@ResourceScopable()
@UseGuards(AuthGuard, WorkspaceAccessGuard)
export class LinksController {
  constructor(
    private readonly relationsService: RelationsService,
    private readonly databases: DatabasesService,
    private readonly records: RecordsService,
  ) {}

  /** #884 — every links response lists linked records by title. */
  private async narrowed<T>(req: WorkspaceRequest, result: Promise<T>): Promise<T> {
    return this.records.narrowTitlesDeep(req.membership, await result);
  }

  private async assertDb(
    req: WorkspaceRequest,
    databaseId: string,
    min: 'viewer' | 'editor' = 'viewer',
  ) {
    await this.databases.assertAccess(req.membership, databaseId, min);
  }

  @Get()
  @ApiOperation({ summary: 'Linked records for a relation field ({id, title} chips)' })
  @ApiParam({
    name: 'field',
    description:
      "The relation field, by api_name (as query filters and value patches name fields) or by id. #458 — an unrecognised field is a 404, never a 500.",
  })
  async list(
    @Req() req: WorkspaceRequest,
    @Param('db') db: string,
    @Param('rec') rec: string,
    @Param('field') field: string,
  ) {
    await this.assertDb(req, db);
    // #884 — a linked record's computed title can carry lookup/rollup values the caller may not read.
    return this.records.narrowTitlesDeep(req.membership, await this.relationsService.listLinks(db, rec, field, req.membership));
  }

  @Post()
  @ApiOperation({ summary: 'Add links (409 when one-to-many already linked)' })
  @ApiParam({
    name: 'field',
    description:
      "The relation field, by api_name (as query filters and value patches name fields) or by id. #458 — an unrecognised field is a 404, never a 500.",
  })
  async add(
    @Req() req: WorkspaceRequest,
    @Param('db') db: string,
    @Param('rec') rec: string,
    @Param('field') field: string,
    @Body() body: LinkRecordsDto,
  ) {
    await this.assertDb(req, db, 'editor');
    return this.narrowed(req, this.relationsService.addLinks(
      req.membership.workspaceId,
      db,
      rec,
      field,
      body.record_ids,
      req.user.id,
      req.auth?.source ?? 'human',
      req.membership,
    ));
  }

  @Put()
  @ApiOperation({ summary: 'Replace all links for this record on this field' })
  @ApiParam({
    name: 'field',
    description:
      "The relation field, by api_name (as query filters and value patches name fields) or by id. #458 — an unrecognised field is a 404, never a 500.",
  })
  async replace(
    @Req() req: WorkspaceRequest,
    @Param('db') db: string,
    @Param('rec') rec: string,
    @Param('field') field: string,
    @Body() body: ReplaceLinksDto,
  ) {
    await this.assertDb(req, db, 'editor');
    return this.narrowed(req, this.relationsService.replaceLinks(
      req.membership.workspaceId,
      db,
      rec,
      field,
      body.record_ids,
      req.user.id,
      req.auth?.source ?? 'human',
      req.membership,
    ));
  }

  @Delete()
  @ApiOperation({ summary: 'Remove specific links' })
  @ApiParam({
    name: 'field',
    description:
      "The relation field, by api_name (as query filters and value patches name fields) or by id. #458 — an unrecognised field is a 404, never a 500.",
  })
  async remove(
    @Req() req: WorkspaceRequest,
    @Param('db') db: string,
    @Param('rec') rec: string,
    @Param('field') field: string,
    @Body() body: LinkRecordsDto,
  ) {
    await this.assertDb(req, db, 'editor');
    return this.narrowed(req, this.relationsService.removeLinks(
      req.membership.workspaceId,
      db,
      rec,
      field,
      body.record_ids,
      req.user.id,
      req.auth?.source ?? 'human',
      req.membership,
    ));
  }
}
