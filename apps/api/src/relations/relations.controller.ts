import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import {
  createRelationSchema,
  deleteRelationSchema,
  linkRecordsSchema,
  replaceLinksSchema,
} from '@storyos/schemas';
import { AuthGuard } from '../auth/auth.guard';
import { RequiresScope } from '../auth/token-scope.guard';
import { WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import { DatabasesService } from '../databases/databases.service';
import { RelationsService } from './relations.service';

class CreateRelationDto extends createZodDto(createRelationSchema) {}
class DeleteRelationDto extends createZodDto(deleteRelationSchema) {}
class LinkRecordsDto extends createZodDto(linkRecordsSchema) {}
class ReplaceLinksDto extends createZodDto(replaceLinksSchema) {}

@ApiTags('relations')
@ApiBearerAuth()
@Controller('workspaces/:ws/relations')
@UseGuards(AuthGuard, WorkspaceAccessGuard)
@RequiresScope('admin')
export class RelationsController {
  constructor(
    private readonly relationsService: RelationsService,
    private readonly databases: DatabasesService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Create a relation — needs creator on BOTH databases' })
  async create(@Req() req: WorkspaceRequest, @Body() body: CreateRelationDto) {
    await this.databases.assertAccess(req.membership, body.database_a_id, 'creator');
    await this.databases.assertAccess(req.membership, body.database_b_id, 'creator');
    return this.relationsService.create(req.membership, body);
  }

  @Delete(':rel')
  @ApiOperation({ summary: 'Delete a relation, both its fields, and all links (confirm: true)' })
  async remove(
    @Req() req: WorkspaceRequest,
    @Param('rel') relationId: string,
    @Body() _body: DeleteRelationDto,
  ) {
    const relation = await this.relationsService.getRelation(req.membership.workspaceId, relationId);
    await this.databases.assertAccess(req.membership, relation.databaseAId, 'creator');
    await this.databases.assertAccess(req.membership, relation.databaseBId, 'creator');
    return this.relationsService.remove(req.membership.workspaceId, relationId);
  }
}

@ApiTags('relations')
@ApiBearerAuth()
@Controller('workspaces/:ws/databases/:db/records/:rec/links/:field')
@UseGuards(AuthGuard, WorkspaceAccessGuard)
export class LinksController {
  constructor(
    private readonly relationsService: RelationsService,
    private readonly databases: DatabasesService,
  ) {}

  private async assertDb(
    req: WorkspaceRequest,
    databaseId: string,
    min: 'viewer' | 'editor' = 'viewer',
  ) {
    await this.databases.assertAccess(req.membership, databaseId, min);
  }

  @Get()
  @ApiOperation({ summary: 'Linked records for a relation field ({id, title} chips)' })
  async list(
    @Req() req: WorkspaceRequest,
    @Param('db') db: string,
    @Param('rec') rec: string,
    @Param('field') field: string,
  ) {
    await this.assertDb(req, db);
    return this.relationsService.listLinks(db, rec, field);
  }

  @Post()
  @ApiOperation({ summary: 'Add links (409 when one-to-many already linked)' })
  async add(
    @Req() req: WorkspaceRequest,
    @Param('db') db: string,
    @Param('rec') rec: string,
    @Param('field') field: string,
    @Body() body: LinkRecordsDto,
  ) {
    await this.assertDb(req, db, 'editor');
    return this.relationsService.addLinks(
      req.membership.workspaceId,
      db,
      rec,
      field,
      body.record_ids,
      req.user.id,
    );
  }

  @Put()
  @ApiOperation({ summary: 'Replace all links for this record on this field' })
  async replace(
    @Req() req: WorkspaceRequest,
    @Param('db') db: string,
    @Param('rec') rec: string,
    @Param('field') field: string,
    @Body() body: ReplaceLinksDto,
  ) {
    await this.assertDb(req, db, 'editor');
    return this.relationsService.replaceLinks(
      req.membership.workspaceId,
      db,
      rec,
      field,
      body.record_ids,
      req.user.id,
    );
  }

  @Delete()
  @ApiOperation({ summary: 'Remove specific links' })
  async remove(
    @Req() req: WorkspaceRequest,
    @Param('db') db: string,
    @Param('rec') rec: string,
    @Param('field') field: string,
    @Body() body: LinkRecordsDto,
  ) {
    await this.assertDb(req, db, 'editor');
    return this.relationsService.removeLinks(
      req.membership.workspaceId,
      db,
      rec,
      field,
      body.record_ids,
      req.user.id,
    );
  }
}
