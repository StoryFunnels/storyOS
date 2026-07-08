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
  changeFieldTypeSchema,
  createFieldSchema,
  createOptionSchema,
  deleteOptionSchema,
  updateFieldSchema,
  updateOptionSchema,
} from '@storyos/schemas';
import { AuthGuard } from '../auth/auth.guard';
import { WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import { DatabasesService } from '../databases/databases.service';
import { FieldsService } from './fields.service';

class CreateFieldDto extends createZodDto(createFieldSchema) {}
class UpdateFieldDto extends createZodDto(updateFieldSchema) {}
class ChangeFieldTypeDto extends createZodDto(changeFieldTypeSchema) {}
class CreateOptionDto extends createZodDto(createOptionSchema) {}
class UpdateOptionDto extends createZodDto(updateOptionSchema) {}
class DeleteOptionDto extends createZodDto(deleteOptionSchema) {}

@ApiTags('fields')
@ApiBearerAuth()
@Controller('workspaces/:ws/databases/:db/fields')
@UseGuards(AuthGuard, WorkspaceAccessGuard)
export class FieldsController {
  constructor(
    private readonly fieldsService: FieldsService,
    private readonly databases: DatabasesService,
  ) {}

  /** Schema ops require `creator` on this database (ADR-0007). */
  private async db(req: WorkspaceRequest, databaseId: string) {
    await this.databases.assertAccess(req.membership, databaseId, 'creator');
    return databaseId;
  }

  @Post()
  @ApiOperation({ summary: 'Add a field (select types accept initial options)' })
  async create(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Body() body: CreateFieldDto,
  ) {
    return this.fieldsService.create(await this.db(req, databaseId), body);
  }

  @Patch(':field')
  @ApiOperation({ summary: 'Rename / reconfigure / reorder a field' })
  async update(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Param('field') fieldId: string,
    @Body() body: UpdateFieldDto,
  ) {
    return this.fieldsService.update(await this.db(req, databaseId), fieldId, body);
  }

  @Delete(':field')
  @ApiOperation({ summary: 'Soft-delete a field (returns records_with_value)' })
  async remove(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Param('field') fieldId: string,
  ) {
    return this.fieldsService.remove(await this.db(req, databaseId), fieldId);
  }

  @Get(':field/usage')
  @ApiOperation({ summary: 'How many live records carry a value for this field' })
  async usage(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Param('field') fieldId: string,
  ) {
    const dbId = await this.db(req, databaseId);
    await this.fieldsService.getField(dbId, fieldId);
    return { records_with_value: await this.fieldsService.usageCount(dbId, fieldId) };
  }

  @Post(':field/change-type')
  @ApiOperation({ summary: 'Convert field type within the compatibility matrix (dry_run supported)' })
  async changeType(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Param('field') fieldId: string,
    @Body() body: ChangeFieldTypeDto,
  ) {
    return this.fieldsService.changeType(
      await this.db(req, databaseId),
      fieldId,
      body.type,
      body.dry_run,
    );
  }

  // --- Options ---

  @Post(':field/options')
  @ApiOperation({ summary: 'Add a select option' })
  async addOption(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Param('field') fieldId: string,
    @Body() body: CreateOptionDto,
  ) {
    return this.fieldsService.addOption(await this.db(req, databaseId), fieldId, body);
  }

  @Patch(':field/options/:option')
  @ApiOperation({ summary: 'Rename / recolor / reorder an option (O(1), ids are stable)' })
  async updateOption(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Param('field') fieldId: string,
    @Param('option') optionId: string,
    @Body() body: UpdateOptionDto,
  ) {
    return this.fieldsService.updateOption(await this.db(req, databaseId), fieldId, optionId, body);
  }

  @Delete(':field/options/:option')
  @ApiOperation({ summary: 'Delete an option — 409 with usage count unless confirm: true' })
  async removeOption(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Param('field') fieldId: string,
    @Param('option') optionId: string,
    @Body() body: DeleteOptionDto,
  ) {
    return this.fieldsService.removeOption(await this.db(req, databaseId), fieldId, optionId, body);
  }
}
