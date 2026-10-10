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
import { createSkillSchema, importSkillSchema, skillExportFormatSchema, updateSkillSchema } from '@storyos/schemas';
import { AuthGuard } from '../auth/auth.guard';
import { MinRole, WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import { SkillsService, publicSkill } from './skills.service';

class CreateSkillDto extends createZodDto(createSkillSchema) {}
class UpdateSkillDto extends createZodDto(updateSkillSchema) {}
class ImportSkillDto extends createZodDto(importSkillSchema) {}

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
  async list(@Req() req: WorkspaceRequest) {
    const { data } = await this.skills.list(req.membership, req.user.id);
    return { data: data.map(publicSkill) };
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
  async get(@Req() req: WorkspaceRequest, @Param('id') id: string) {
    return publicSkill(await this.skills.get(req.membership, req.user.id, id));
  }

  @Post()
  @MinRole('member')
  @ApiOperation({ summary: 'Create a skill — shared with the workspace by default, whether a person or an agent (token, connected AI) creates it. An agent can also share it with named workspace members; making one public only raises an approval a person must give. A workspace admin can switch agent publishing off, after which an agent-authored skill is created personal' })
  async create(@Req() req: WorkspaceRequest, @Body() body: CreateSkillDto) {
    // #442: authorship comes from the AUTH context, never the body — a caller
    // must not be able to describe itself as a human.
    return publicSkill(await this.skills.create(req.membership, req.user.id, body, req.auth.source));
  }

  /**
   * #841 — import a SKILL.md. Declared before the `:id` routes. Preview by default (the
   * KEPT/DROPPED report, nothing written); `create: true` writes it. Authorship comes from
   * the auth context exactly as on create, and the same publish gate applies.
   */
  @Post('import')
  @MinRole('member')
  @ApiOperation({
    summary: 'Import a SKILL.md: returns a KEPT/DROPPED report first; pass create:true to write the skill',
  })
  async import(@Req() req: WorkspaceRequest, @Body() body: ImportSkillDto) {
    const result = await this.skills.importSkill(
      req.membership,
      req.user.id,
      { content: body.content, create: body.create, overrides: body.overrides },
      req.auth.source,
    );
    return { ...result, created: result.created ? publicSkill(result.created) : null };
  }

  @Patch(':id')
  @MinRole('member')
  @ApiParam({ name: 'id', description: 'The skill record id' })
  @ApiOperation({ summary: "Edit a skill — owner-only, even if it's shared" })
  async update(@Req() req: WorkspaceRequest, @Param('id') id: string, @Body() body: UpdateSkillDto) {
    return publicSkill(await this.skills.update(req.membership, req.user.id, id, body, req.auth.source));
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
   * Manual run (AC #3). There is no in-app Skills list, Run button or chat
   * slash command — this endpoint IS the agent-invocation surface for a skill
   * (the MCP `run_skill` tool calls it), mirroring AgentsController's
   * `POST :agent/run`.
   */
  @Post(':id/run')
  @ApiParam({ name: 'id', description: 'The skill record id' })
  @ApiOperation({ summary: 'Run a skill manually; returns its step log (no model invoked yet)' })
  run(@Req() req: WorkspaceRequest, @Param('id') id: string) {
    return this.skills.run(req.membership, req.user.id, id);
  }
}
