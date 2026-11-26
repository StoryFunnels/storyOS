import { Controller, ForbiddenException, Get, HttpException, Inject, NotFoundException, Param, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { and, eq, sql } from 'drizzle-orm';
import { parseIdentifier, recordResponseSchema } from '@storyos/schemas';
import { BOUNDARY_REFUSAL, ResourceScopable } from '../access/resource-scope';
import { AuthGuard } from '../auth/auth.guard';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { databases } from '../db/schema';
import { notDeleted } from '../db/soft-delete';
import { DatabasesService } from '../databases/databases.service';
import { WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import { RecordsService } from './records.service';

class IdentifiedRecordResponseDto extends createZodDto(recordResponseSchema.extend({ database_id: z.uuid() })) {}

/**
 * Ticket #1363 — open a record by its identifier (`ISSUE-5201`) without knowing which database holds it.
 *
 * The door is the SAME one every record route uses: the prefix names a database, `assertAccess` decides whether this caller may see
 * it, and `getByNumber` then applies the per-record check. Nothing here decides access itself.
 *
 * NO ORACLE. A prefix that matches no database, text that is not shaped like an identifier, a database the caller cannot see, and a
 * number that does not exist all answer the identical 404 `Record not found` (a token bound to specific databases gets its one
 * boundary refusal for every one of them, as everywhere else). Were an unknown prefix told apart from a hidden database, the route
 * would map out the names of databases the caller is not allowed to know about, which is exactly what ADR-0018 (b) forbids.
 */
@ApiTags('records')
@ApiBearerAuth()
@Controller('workspaces/:ws/records')
@ResourceScopable()
@UseGuards(AuthGuard, WorkspaceAccessGuard)
export class RecordIdentifiersController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly databases: DatabasesService,
    private readonly recordsService: RecordsService,
  ) {}

  @Get('by-identifier/:identifier')
  @ApiOperation({
    summary:
      'Resolve a record by its identifier, e.g. ISSUE-5201 (the database identifier prefix, a dash, the record number; the prefix is case-insensitive). 404 for an unknown prefix, a database you cannot see and a missing number alike.',
  })
  @ApiOkResponse({ type: IdentifiedRecordResponseDto })
  async getByIdentifier(@Req() req: WorkspaceRequest, @Param('identifier') identifier: string) {
    const notFound = () => (req.membership.bound ? new ForbiddenException(BOUNDARY_REFUSAL) : new NotFoundException('Record not found'));
    const parsed = parseIdentifier(identifier);
    if (!parsed) throw notFound();
    const database = await this.db.query.databases.findFirst({
      where: and(
        eq(databases.workspaceId, req.membership.workspaceId),
        sql`lower(${databases.identifierPrefix}) = lower(${parsed.prefix})`,
        notDeleted(databases.deletedAt),
      ),
      columns: { id: true },
    });
    if (!database) throw notFound();
    try {
      await this.databases.assertAccess(req.membership, database.id, 'viewer');
    } catch (err) {
      // whatever the refusal was (not found, no grant), the caller hears the unknown-prefix answer, never a different one
      if (err instanceof HttpException && (err.getStatus() === 404 || err.getStatus() === 403)) throw notFound();
      throw err;
    }
    const record = await this.recordsService.getByNumber(database.id, parsed.number, req.membership);
    return { ...record, database_id: database.id };
  }
}
