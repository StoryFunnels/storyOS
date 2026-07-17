import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { packExportRequestSchema } from '@storyos/schemas';
import { AuthGuard } from '../auth/auth.guard';
import { MinRole, WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import { PacksService } from './packs.service';

/**
 * The export request is an ordinary API input — the caller is a person or the
 * SDK, describing a slice of the workspace in front of them — so it gets a real
 * DTO, a real OpenAPI schema and the pipe's ordinary 400.
 */
class ExportDto extends createZodDto(packExportRequestSchema) {}

/**
 * The manifest, by contrast, arrives as `unknown` and is validated inside the
 * service.
 *
 * The same reasoning as `ArchitectController`: a DTO-level parse would reject a
 * malformed manifest with a generic 400 from the pipe, losing the chance to say
 * *which* part is wrong — and the contract here is a 422 carrying issues an
 * operator can act on. A manifest has by definition been out of the building
 * (written to a file, hand-edited, carried between workspaces), so it is
 * re-validated at exactly one boundary: `PacksService.install`. `.optional()`
 * for the same reason — an absent manifest is a malformed one, and it deserves
 * the service's answer rather than the pipe's.
 */
const installSchema = z.object({ manifest: z.unknown().optional() });
class InstallDto extends createZodDto(installSchema) {}

/**
 * Business Packs (MN-218 / #160).
 *
 * Admin-gated, like the Architect and the agents controller: a pack creates
 * databases, relations, automations and agents, which is schema work — the most
 * privileged thing a workspace member can do.
 */
@ApiTags('packs')
@UseGuards(AuthGuard, WorkspaceAccessGuard)
@MinRole('admin')
@Controller('workspaces/:ws/packs')
export class PacksController {
  constructor(private readonly packs: PacksService) {}

  /**
   * Export a slice of this workspace as a pack manifest. Reads only.
   *
   * This is also the template-authoring path: a pack is authored by building the
   * business in a workspace and exporting it, rather than by hand-writing JSON.
   */
  @Post('export')
  @ApiOperation({ summary: 'Export a workspace slice as a pack manifest; creates nothing' })
  exportPack(@Req() req: WorkspaceRequest, @Body() body: ExportDto) {
    return this.packs.export(req.membership, body);
  }

  /**
   * Install a manifest into this workspace. Deterministic and idempotent —
   * installing the same manifest twice creates nothing the second time.
   *
   * Unmet requirements (a missing Slack connection, managed AI) come back in
   * `unmet` rather than failing the install.
   */
  @Post('install')
  @ApiOperation({ summary: 'Install a pack manifest; idempotent' })
  install(@Req() req: WorkspaceRequest, @Body() body: InstallDto) {
    return this.packs.install(req.membership, body.manifest);
  }
}
