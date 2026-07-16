import { Body, Controller, Delete, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import { FavoritesService } from './favorites.service';
import type { FavoriteTarget } from './favorites.service';

class FavoriteDto extends createZodDto(
  z.object({
    target_type: z.enum(['record', 'database']),
    target_id: z.uuid(),
  }),
) {}

/** Favorites (MN-075) — per-user stars on records/databases. Any member can star. */
@ApiTags('favorites')
@UseGuards(AuthGuard, WorkspaceAccessGuard)
@Controller('workspaces/:ws/favorites')
export class FavoritesController {
  constructor(private readonly favorites: FavoritesService) {}

  @Get()
  @ApiOperation({ summary: "Current user's favorites in this workspace (resolved titles)" })
  list(@Req() req: WorkspaceRequest) {
    return this.favorites.list(req.membership);
  }

  @Post()
  @ApiOperation({ summary: 'Star a record or database' })
  add(@Req() req: WorkspaceRequest, @Body() body: FavoriteDto) {
    return this.favorites.add(req.membership, body.target_type, body.target_id);
  }

  @Delete(':type/:id')
  @ApiOperation({ summary: 'Unstar' })
  remove(@Req() req: WorkspaceRequest, @Param('type') type: FavoriteTarget, @Param('id') id: string) {
    return this.favorites.remove(req.membership, type, id);
  }
}
