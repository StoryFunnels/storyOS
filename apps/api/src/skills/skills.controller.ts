import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { createSkillSchema, skillExportFormatSchema, updateSkillSchema } from '@storyos/schemas';
import { AuthGuard } from '../auth/auth.guard';
import { MinRole, WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import { SkillsService } from './skills.service';

class CreateSkillDto extends createZodDto(createSkillSchema) {}
class UpdateSkillDto extends createZodDto(updateSkillSchema) {}

/**
 * #40 — the Skills framework. Any active member can list/read/run/export a
 * skill (personal ones stay invisible to everyone but their owner —
 * SkillsService.findVisible); creating, editing and deleting need at least
 * `member` (not `guest`), the same floor AutomationsController uses for
 * workspace-config-grade writes.
 */
@ApiTags('skills')
@UseGuards(AuthGuard, WorkspaceAccessGuard)
@Controller('workspaces/:ws/skills')
export class SkillsController {
  constructor(private readonly skills: SkillsService) {}

  @Get()
  @ApiOperation({ summary: 'List skills visible to the caller: their own, plus every shared one' })
  list(@Req() req: WorkspaceRequest) {
    return this.skills.list(req.membership, req.user.id);
  }

  /**
   * Declared before `:id` — NestJS matches routes in registration order, and
   * `templates` would otherwise be swallowed as an `:id` lookup.
   */
  @Get('templates')
  @ApiOperation({ summary: 'Starter scaffolds for the "new skill" flow (AC #2, not-from-scratch)' })
  templates() {
    return this.skills.templates();
  }

  @Get(':id')
  @ApiParam({ name: 'id', description: 'The skill record id' })
  @ApiOperation({ summary: 'Read one skill' })
  get(@Req() req: WorkspaceRequest, @Param('id') id: string) {
    return this.skills.get(req.membership, req.user.id, id);
  }

  @Post()
  @MinRole('member')
  @ApiOperation({ summary: 'Create a skill — personal by default; pass visibility: "shared" to publish it to the workspace' })
  create(@Req() req: WorkspaceRequest, @Body() body: CreateSkillDto) {
    return this.skills.create(req.membership, req.user.id, body);
  }

  @Patch(':id')
  @MinRole('member')
  @ApiParam({ name: 'id', description: 'The skill record id' })
  @ApiOperation({ summary: "Edit a skill — owner-only, even if it's shared" })
  update(@Req() req: WorkspaceRequest, @Param('id') id: string, @Body() body: UpdateSkillDto) {
    return this.skills.update(req.membership, req.user.id, id, body);
  }

  @Delete(':id')
  @MinRole('member')
  @ApiParam({ name: 'id', description: 'The skill record id' })
  @ApiOperation({ summary: 'Delete a skill — owner-only' })
  remove(@Req() req: WorkspaceRequest, @Param('id') id: string) {
    return this.skills.remove(req.membership, req.user.id, id);
  }

  @Get(':id/export')
  @ApiParam({ name: 'id', description: 'The skill record id' })
  @ApiQuery({ name: 'format', enum: ['markdown', 'claude_skill', 'chatgpt'] })
  @ApiOperation({
    summary: 'Export a skill as portable instructions (Markdown / Claude Skill SKILL.md / ChatGPT)',
  })
  async export(@Req() req: WorkspaceRequest, @Param('id') id: string, @Query('format') format?: string) {
    const parsed = skillExportFormatSchema.safeParse(format);
    if (!parsed.success) {
      throw new BadRequestException(
        `format must be one of: markdown, claude_skill, chatgpt (got "${format ?? ''}")`,
      );
    }
    return this.skills.exportSkill(req.membership, req.user.id, id, parsed.data);
  }

  /**
   * Manual run (AC #3). The chat composer's Skills menu / slash command
   * (#39) doesn't exist yet — this endpoint IS the current agent-invocation
   * surface for a skill, mirroring AgentsController's `POST :agent/run`.
   */
  @Post(':id/run')
  @ApiParam({ name: 'id', description: 'The skill record id' })
  @ApiOperation({ summary: 'Run a skill manually; returns its step log (no model invoked yet)' })
  run(@Req() req: WorkspaceRequest, @Param('id') id: string) {
    return this.skills.run(req.membership, req.user.id, id);
  }
}
