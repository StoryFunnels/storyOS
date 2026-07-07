import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import {
  createDatabaseSchema,
  deleteDatabaseSchema,
  updateDatabaseSchema,
} from '@storyos/schemas';
import { AuthGuard } from '../auth/auth.guard';
import { MinRole, WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import { DatabasesService } from './databases.service';

class CreateDatabaseDto extends createZodDto(createDatabaseSchema) {}
class UpdateDatabaseDto extends createZodDto(updateDatabaseSchema) {}
class DeleteDatabaseDto extends createZodDto(deleteDatabaseSchema) {}

@ApiTags('databases')
@ApiBearerAuth()
@Controller('workspaces/:ws/databases')
@UseGuards(AuthGuard, WorkspaceAccessGuard)
export class DatabasesController {
  constructor(private readonly databases: DatabasesService) {}

  @Get()
  @ApiOperation({ summary: 'List databases (guests: scoped spaces only)' })
  list(@Req() req: WorkspaceRequest) {
    return this.databases.list(req.membership);
  }

  @Post()
  @MinRole('member')
  @ApiOperation({ summary: 'Create a database (auto: title field, system fields, default view)' })
  create(@Req() req: WorkspaceRequest, @Body() body: CreateDatabaseDto) {
    return this.databases.create(req.membership, body);
  }

  @Get(':db')
  @ApiOperation({ summary: 'Database with live fields and views (schema introspection)' })
  get(@Req() req: WorkspaceRequest, @Param('db') databaseId: string) {
    return this.databases.get(req.membership, databaseId);
  }

  @Patch(':db')
  @MinRole('member')
  @ApiOperation({ summary: 'Rename / re-icon / move between spaces' })
  update(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Body() body: UpdateDatabaseDto,
  ) {
    return this.databases.update(req.membership, databaseId, body);
  }

  @Delete(':db')
  @MinRole('member')
  @ApiOperation({ summary: 'Hard delete — body.confirm must equal the database name' })
  remove(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Body() body: DeleteDatabaseDto,
  ) {
    return this.databases.remove(req.membership, databaseId, body.confirm, body.sever_relations);
  }
}
