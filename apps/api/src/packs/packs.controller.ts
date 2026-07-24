import { Body, Controller, Get, NotFoundException, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  packExportRequestSchema,
  packInstallResolutionsSchema,
  packListingMetaSchema,
} from '@storyos/schemas';
import { AuthGuard } from '../auth/auth.guard';
import { MinRole, WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import { MarketplaceService } from './marketplace.service';
import { PACK_REGISTRY } from './registry';
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
const installSchema = z.object({
  manifest: z.unknown().optional(),
  /** How to resolve each `collision` `preview` reported (MN-219 / #161). */
  resolutions: packInstallResolutionsSchema.optional(),
});
class InstallDto extends createZodDto(installSchema) {}

/**
 * A submission (MN-220): same `unknown` + service-level 422 contract as
 * `InstallDto` for the manifest half — see that class's doc — plus the
 * listing metadata (`packListingMetaSchema`), which IS an ordinary validated
 * DTO field, because it's plain author input, not something that's been out
 * of the building.
 */
const submitSchema = packListingMetaSchema.extend({ manifest: z.unknown().optional() });
class SubmitDto extends createZodDto(submitSchema) {}

/**
 * The built-in gallery (MN-219 / #161) is static, workspace-independent
 * metadata — the same reason `GET /templates` sits outside the
 * `workspaces/:ws` namespace (see `templates.controller.ts`). Any
 * authenticated user may browse it; installing is what's admin-gated.
 */
@ApiTags('packs')
@UseGuards(AuthGuard)
@Controller('packs')
export class PacksRegistryController {
  @Get('registry')
  @ApiOperation({ summary: 'The built-in Business Pack gallery' })
  registry() {
    return PACK_REGISTRY.map(({ manifest, ...card }) => ({
      ...card,
      preview: {
        databases: manifest.databases.length,
        views: manifest.views.length,
        automations: manifest.automations.length,
        agents: manifest.agents.length,
      },
    }));
  }

  @Get('registry/:slug')
  @ApiOperation({ summary: 'One built-in pack, manifest included' })
  entry(@Param('slug') slug: string) {
    const found = PACK_REGISTRY.find((p) => p.slug === slug);
    if (!found) throw new NotFoundException(`No pack "${slug}" in the registry.`);
    return found;
  }
}

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
  constructor(
    private readonly packs: PacksService,
    private readonly marketplace: MarketplaceService,
  ) {}

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
   * `unmet` rather than failing the install. A name collision `preview`
   * reported and left unresolved comes back as a 409 (MN-219 / #161) — see
   * `resolutions`.
   */
  @Post('install')
  @ApiOperation({ summary: 'Install a pack manifest; idempotent' })
  install(@Req() req: WorkspaceRequest, @Body() body: InstallDto) {
    return this.packs.install(req.membership, body.manifest, body.resolutions);
  }

  /**
   * Preview a manifest: which databases/views/automations/agents would be
   * created, reused, or collide with something this pack didn't make — and
   * what's unmet — without installing anything (MN-219 / #161). Same input
   * contract as install — a manifest that has been out of the building — so
   * it gets the same `unknown` + service-level 422, not a DTO-level 400.
   */
  @Post('preview')
  @ApiOperation({ summary: 'Preview what installing a manifest would do; creates nothing' })
  preview(@Req() req: WorkspaceRequest, @Body() body: InstallDto) {
    return this.packs.preview(req.membership, body.manifest);
  }

  /** Every pack tracked as installed in this workspace (MN-219 / #161). */
  @Get('installed')
  @ApiOperation({ summary: 'List tracked pack installs in this workspace' })
  installed(@Req() req: WorkspaceRequest) {
    return this.packs.listInstalls(req.membership);
  }

  /**
   * Uninstall a tracked install: removes its views/automations/agents/skills
   * that are unmodified since install, keeps anything changed since with a
   * reason (MN-219 / #161). Schema is never touched — see
   * `PacksService.uninstall`'s doc.
   */
  @Post(':installId/uninstall')
  @ApiOperation({ summary: 'Uninstall a tracked pack install' })
  uninstall(@Req() req: WorkspaceRequest, @Param('installId') installId: string) {
    return this.packs.uninstall(req.membership, installId);
  }

  /**
   * Submit an exported manifest to the community marketplace for review
   * (MN-220). Creates a `pending` submission — nothing is published until a
   * platform admin approves it (`admin.controller.ts`).
   */
  @Post('submissions')
  @ApiOperation({ summary: 'Submit a pack manifest to the marketplace for review' })
  submit(@Req() req: WorkspaceRequest, @Body() body: SubmitDto) {
    const { manifest, ...meta } = body;
    return this.marketplace.submit(req.membership, manifest, meta);
  }

  /** This workspace's own submissions and their review status (MN-220). */
  @Get('submissions')
  @ApiOperation({ summary: "List this workspace's marketplace submissions" })
  mySubmissions(@Req() req: WorkspaceRequest) {
    return this.marketplace.listMySubmissions(req.membership);
  }
}

/**
 * The Community Marketplace browse view (MN-220) — published, curated packs,
 * in-app. Same authenticated-but-not-admin gate as `PacksRegistryController`:
 * browsing is not schema work, installing is (that stays behind
 * `PacksController.install`, given the manifest `entry` returns here).
 *
 * Deliberately separate from `PacksRegistryController`: the built-in gallery
 * is static, hand-authored, code-shipped content (`registry.ts`'s doc);
 * this is community-submitted, database-backed, and versioned. Folding them
 * into one endpoint would need a "source" flag on every card for no benefit —
 * nothing reads them as a single list today, and `PacksService.listInstalls`
 * (the one place that treats them uniformly) does so through
 * `MarketplaceService.latestVersionOf`, which already checks both.
 */
@ApiTags('packs')
@UseGuards(AuthGuard)
@Controller('packs/marketplace')
export class MarketplaceController {
  constructor(private readonly marketplace: MarketplaceService) {}

  @Get()
  @ApiOperation({ summary: 'Browse published Community Marketplace packs' })
  list() {
    return this.marketplace.listPublished();
  }

  @Get(':slug')
  @ApiOperation({ summary: 'One published pack — manifest, changelog, versions' })
  entry(@Param('slug') slug: string) {
    return this.marketplace.getPublished(slug);
  }
}
