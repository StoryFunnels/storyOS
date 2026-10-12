import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { createValidationRuleSchema, updateValidationRuleSchema } from '@storyos/schemas';
import { AuthGuard } from '../auth/auth.guard';
import { RequiresScope } from '../auth/token-scope.guard';
import { DatabasesService } from '../databases/databases.service';
import { MinRole, WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import { ValidationRulesService } from './validation-rules.service';

class CreateValidationRuleDto extends createZodDto(createValidationRuleSchema) {}
class UpdateValidationRuleDto extends createZodDto(updateValidationRuleSchema) {}

/**
 * #231 — validation rules, admin only. There is no bypass for any writer (see `validationRules` in the schema), so
 * declaring or changing one is a decision for an admin, and a rule that is wrong is changed here, visibly.
 * Not `@ResourceScopable`, so a token bound to specific spaces/databases (#543) cannot reach it.
 */
@ApiTags('validation-rules')
@ApiBearerAuth()
@Controller('workspaces/:ws/databases/:db/validation-rules')
@UseGuards(AuthGuard, WorkspaceAccessGuard)
@RequiresScope('admin')
@MinRole('admin')
export class ValidationRulesController {
  constructor(
    private readonly rules: ValidationRulesService,
    private readonly databases: DatabasesService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List this database\'s validation rules, each with how many stored records break it now' })
  async list(@Req() req: WorkspaceRequest, @Param('db') databaseId: string) {
    await this.databases.assertAccess(req.membership, databaseId, 'creator');
    return this.rules.list(databaseId);
  }

  @Post()
  @ApiOperation({
    summary:
      'Declare a rule that REFUSES a record write when its condition is not met. Applies to every writer, admins included; no bypass.',
  })
  async create(@Req() req: WorkspaceRequest, @Param('db') databaseId: string, @Body() body: CreateValidationRuleDto) {
    await this.databases.assertAccess(req.membership, databaseId, 'creator');
    return this.rules.create(req.membership.workspaceId, databaseId, body, req.user.id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Change a rule\'s name, condition, message or enabled flag (the trigger is fixed)' })
  async update(@Req() req: WorkspaceRequest, @Param('db') databaseId: string, @Param('id') id: string, @Body() body: UpdateValidationRuleDto) {
    await this.databases.assertAccess(req.membership, databaseId, 'creator');
    return this.rules.update(databaseId, id, body, req.user.id);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a rule' })
  async remove(@Req() req: WorkspaceRequest, @Param('db') databaseId: string, @Param('id') id: string) {
    await this.databases.assertAccess(req.membership, databaseId, 'creator');
    return this.rules.remove(databaseId, id);
  }

  @Get(':id/violations')
  @ApiOperation({
    summary:
      'The stored records that ALREADY break this rule (a rule only fires when a field it references changes, so existing violations persist; this is how they are seen)',
  })
  async violations(@Req() req: WorkspaceRequest, @Param('db') databaseId: string, @Param('id') id: string, @Query('after') after?: string) {
    await this.databases.assertAccess(req.membership, databaseId, 'creator');
    return this.rules.violations(databaseId, id, after ? Number(after) : undefined);
  }
}
