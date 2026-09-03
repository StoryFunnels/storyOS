import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { PublicViewsService } from './public-views.service';

/**
 * Public view endpoints (#264) — deliberately NO AuthGuard, mirroring
 * `PublicFormsController`. The `token` is the only credential; the service
 * resolves the workspace/database/allowlist from it and never trusts any
 * caller-supplied scope. Read-only — there is no write endpoint here, ever.
 */
@ApiTags('public')
@Controller('public/views')
export class PublicViewsController {
  constructor(private readonly publicViews: PublicViewsService) {}

  @Get(':token')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: 'Public view definition + one page of records (link/public access only)' })
  get(@Param('token') token: string, @Query('cursor') cursor?: string) {
    return this.publicViews.getPublicView(token, { cursor });
  }
}
