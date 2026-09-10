import { Body, Controller, Delete, Get, Param, Patch, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import { SpaceDocumentsService } from './space-documents.service';

/** Mirrors export/csv.ts's csvFilename — same slug shape, `.md` instead. */
function markdownFilename(title: string): string {
  const slug = title.trim().replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'document';
  return `${slug}.md`;
}

// #283: max(16) was too small even for existing `set:<name>` refs (e.g.
// `set:layout-dashboard` is 20 chars) — bumped to match the max(48) convention
// used by createSpaceSchema/createDatabaseSchema. The service
// (SpaceDocumentsService) normalizes any raw emoji through the migration
// table before it's persisted, so this bound only needs to fit a `set:` ref
// or a short emoji.
const createSchema = z.object({ title: z.string().max(200).optional(), icon: z.string().max(48).optional() });
class CreateSpaceDocDto extends createZodDto(createSchema) {}

const updateSchema = z.object({
  title: z.string().max(200).optional(),
  icon: z.string().max(48).nullable().optional(),
  content: z.unknown().optional(),
  expected_version: z.number().int().min(0).optional(),
  /** #368 — sidebar placement, mirroring what views got in #347. */
  folder_id: z.string().uuid().nullable().optional(),
});
class UpdateSpaceDocDto extends createZodDto(updateSchema) {}

// #293 — target space for "Move to shared space"; the service rejects a
// personal target rather than trusting the client not to send its own.
const moveSchema = z.object({ space_id: z.string().uuid() });
class MoveSpaceDocDto extends createZodDto(moveSchema) {}

@ApiTags('documents')
@ApiBearerAuth()
@Controller('workspaces/:ws')
@UseGuards(AuthGuard, WorkspaceAccessGuard)
export class SpaceDocumentsController {
  constructor(private readonly docs: SpaceDocumentsService) {}

  @Get('spaces/:space/documents')
  @ApiOperation({ summary: 'Standalone documents in a space (MN-095)' })
  async list(@Req() req: WorkspaceRequest, @Param('space') space: string) {
    return { data: await this.docs.list(req.membership, space) };
  }

  @Post('spaces/:space/documents')
  @ApiOperation({ summary: 'Create a standalone document in a space' })
  async create(@Req() req: WorkspaceRequest, @Param('space') space: string, @Body() body: CreateSpaceDocDto) {
    return this.docs.create(req.membership, space, body, req.user.id);
  }

  @Get('documents/:doc')
  @ApiOperation({ summary: 'A standalone document (BlockNote content + version)' })
  async get(@Req() req: WorkspaceRequest, @Param('doc') doc: string) {
    return this.docs.get(req.membership, doc);
  }

  /**
   * #262 — phase 1 of PDF export: the same "whole document" Markdown, on its
   * own, since PDF rendering will reuse this serializer rather than write a
   * second one directly against BlockNote (Ievgen's own sequencing note on
   * the ticket: MD export ships first, PDF reuses it).
   */
  @Get('documents/:doc/export/markdown')
  @ApiOperation({ summary: 'Download the document as Markdown (#262 — the PDF export reuses this serializer)' })
  async exportMarkdown(@Req() req: WorkspaceRequest, @Param('doc') doc: string, @Res() reply: FastifyReply) {
    const { title, markdown } = await this.docs.exportMarkdown(req.membership, doc);
    reply.header('content-type', 'text/markdown; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="${markdownFilename(title)}"`);
    return reply.send(markdown);
  }

  @Patch('documents/:doc')
  @ApiOperation({ summary: 'Update title/icon/content — 409 on version conflict' })
  async update(@Req() req: WorkspaceRequest, @Param('doc') doc: string, @Body() body: UpdateSpaceDocDto) {
    return this.docs.update(req.membership, doc, body);
  }

  @Delete('documents/:doc')
  @ApiOperation({ summary: 'Delete a standalone document' })
  async remove(@Req() req: WorkspaceRequest, @Param('doc') doc: string) {
    return this.docs.remove(req.membership, doc);
  }

  @Post('documents/:doc/move')
  @ApiOperation({ summary: 'Move a document to a shared space (one-way out of Personal; notifies its mentions)' })
  async move(@Req() req: WorkspaceRequest, @Param('doc') doc: string, @Body() body: MoveSpaceDocDto) {
    return this.docs.moveToSpace(req.membership, doc, body.space_id, req.user.id);
  }

  @Post('documents/:doc/copy-to-personal')
  @ApiOperation({ summary: 'Copy a document into my personal space (independent fork, no sync)' })
  async copyToPersonal(@Req() req: WorkspaceRequest, @Param('doc') doc: string) {
    return this.docs.copyToPersonal(req.membership, doc, req.user.id);
  }
}
