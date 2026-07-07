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
import { MinRole, WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
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
@MinRole('member')
export class RelationsController {
  constructor(private readonly relationsService: RelationsService) {}

  @Post()
  @ApiOperation({ summary: 'Create a relation — provisions paired fields on both databases' })
  create(@Req() req: WorkspaceRequest, @Body() body: CreateRelationDto) {
    return this.relationsService.create(req.membership, body);
  }

  @Delete(':rel')
  @ApiOperation({ summary: 'Delete a relation, both its fields, and all links (confirm: true)' })
  remove(
    @Req() req: WorkspaceRequest,
    @Param('rel') relationId: string,
    @Body() _body: DeleteRelationDto,
  ) {
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

  private async assertDb(req: WorkspaceRequest, databaseId: string) {
    await this.databases.get(req.membership, databaseId);
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
  @MinRole('member')
  @ApiOperation({ summary: 'Add links (409 when one-to-many already linked)' })
  async add(
    @Req() req: WorkspaceRequest,
    @Param('db') db: string,
    @Param('rec') rec: string,
    @Param('field') field: string,
    @Body() body: LinkRecordsDto,
  ) {
    await this.assertDb(req, db);
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
  @MinRole('member')
  @ApiOperation({ summary: 'Replace all links for this record on this field' })
  async replace(
    @Req() req: WorkspaceRequest,
    @Param('db') db: string,
    @Param('rec') rec: string,
    @Param('field') field: string,
    @Body() body: ReplaceLinksDto,
  ) {
    await this.assertDb(req, db);
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
  @MinRole('member')
  @ApiOperation({ summary: 'Remove specific links' })
  async remove(
    @Req() req: WorkspaceRequest,
    @Param('db') db: string,
    @Param('rec') rec: string,
    @Param('field') field: string,
    @Body() body: LinkRecordsDto,
  ) {
    await this.assertDb(req, db);
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
