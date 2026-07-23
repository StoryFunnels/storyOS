import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PACK_REGISTRY, toPublicPreview } from './registry';

/**
 * Public, pre-signup Business Pack preview (#272).
 *
 * `PacksRegistryController` (`packs.controller.ts`) already serves the built-in
 * gallery, but behind `AuthGuard` — any *logged-in* user may browse it, per
 * that controller's doc. That leaves a shared pack link with zero viral
 * surface: a creator posting "here's my agency-ops-in-a-box pack" needs the
 * link itself to land on a preview, not a login wall (finding #272, from the
 * Promotion Strategy doc).
 *
 * Deliberately NO AuthGuard — same shape as `PublicFormsController`, except
 * there is no per-pack secret token to check: the registry is static,
 * workspace-independent metadata to begin with (see
 * `PacksRegistryController`'s doc), so every slug in it is meant to be public.
 * `toPublicPreview` still narrows each entry to a public-safe shape rather
 * than reusing the authenticated `registry()`/`entry()` responses verbatim —
 * see `packPublicPreviewSchema`'s doc for why the full ref-encoded manifest
 * doesn't belong on an unauthenticated route.
 */
@ApiTags('public')
@Controller('public/packs')
export class PublicPacksController {
  @Get('registry')
  @ApiOperation({ summary: 'The built-in Business Pack gallery — public, pre-signup' })
  registry() {
    return PACK_REGISTRY.map(({ manifest: _manifest, ...card }) => card);
  }

  @Get('registry/:slug')
  @ApiOperation({ summary: 'One built-in pack — public, pre-signup preview' })
  entry(@Param('slug') slug: string) {
    const found = PACK_REGISTRY.find((p) => p.slug === slug);
    if (!found) throw new NotFoundException(`No pack "${slug}" in the registry.`);
    return toPublicPreview(found);
  }
}
