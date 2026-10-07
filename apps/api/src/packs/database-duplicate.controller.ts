import { Body, Controller, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import { PacksService } from './packs.service';

const duplicateDatabaseSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  include_records: z.boolean().default(false),
});
class DuplicateDatabaseDto extends createZodDto(duplicateDatabaseSchema) {}

/**
 * #266 — lives in `packs/` rather than `databases/` because it's built ENTIRELY
 * out of `PacksService.export`/`install`, and `PacksModule` is the side of the
 * import graph that already depends on `DatabasesModule` (not the reverse) —
 * see `PacksService.duplicateDatabase`'s own doc for the mechanism. Access is
 * the same `creator` bar field/schema creation uses everywhere else
 * (`DatabasesService.assertAccess`, called inside the service), not a
 * workspace-wide admin gate — duplicating a database is schema work a database
 * creator can already do by hand, field by field.
 */
@ApiTags('databases')
@ApiBearerAuth()
@Controller('workspaces/:ws/databases/:db')
@UseGuards(AuthGuard, WorkspaceAccessGuard)
export class DatabaseDuplicateController {
  constructor(private readonly packs: PacksService) {}

  @Post('duplicate')
  @ApiOperation({ summary: 'Duplicate a database — schema, or schema + records (#266)' })
  duplicate(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Body() body: DuplicateDatabaseDto,
  ) {
    return this.packs.duplicateDatabase(req.membership, databaseId, {
      name: body.name,
      include_records: body.include_records,
    });
  }
}
