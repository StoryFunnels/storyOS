import {
  BadRequestException,
  Controller,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { AuthGuard } from '../auth/auth.guard';
import { WorkspaceAccessGuard, MinRole } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import { DatabasesService } from '../databases/databases.service';
import { ImportService } from './import.service';
import type { ColumnMapping } from './import.service';

interface MultipartField { value?: string }

/** CSV import (MN-052). Multipart: file + fields mapping (JSON) + dry_run. */
@ApiTags('import')
@UseGuards(AuthGuard, WorkspaceAccessGuard)
@Controller('workspaces/:ws/databases/:db/import')
export class ImportController {
  constructor(
    private readonly importService: ImportService,
    private readonly databases: DatabasesService,
  ) {}

  @Post()
  @MinRole('member')
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Import CSV: fields "file", "mapping" (JSON), "dry_run" ("true"/"false")' })
  async run(@Req() req: WorkspaceRequest, @Param('db') databaseId: string) {
    await this.databases.assertAccess(req.membership, databaseId, 'creator');
    const raw = req as unknown as FastifyRequest & {
      file?: (opts?: object) => Promise<
        | { fields: Record<string, MultipartField | MultipartField[]>; toBuffer: () => Promise<Buffer> }
        | undefined
      >;
    };
    if (typeof raw.file !== 'function') throw new BadRequestException('multipart body expected');
    const file = await raw.file();
    if (!file) throw new BadRequestException('multipart field "file" is required');
    const buffer = await file.toBuffer();

    const fieldValue = (name: string): string | undefined => {
      const f = file.fields[name];
      const one = Array.isArray(f) ? f[0] : f;
      return one?.value;
    };
    let mapping: ColumnMapping[];
    try {
      mapping = JSON.parse(fieldValue('mapping') ?? '[]');
    } catch {
      throw new BadRequestException('mapping must be JSON');
    }
    if (!Array.isArray(mapping) || mapping.length === 0) {
      // No mapping yet → parse + infer only (wizard step 2 bootstrap).
      const { headers, rows } = this.importService.parseCsv(buffer);
      return {
        inferred: this.importService.inferTypes(headers, rows),
        rows: rows.length,
        sample_rows: rows.slice(0, 3),
      };
    }
    const dryRun = fieldValue('dry_run') !== 'false';
    return this.importService.run(req.membership, databaseId, buffer, mapping, dryRun, req.user.id);
  }
}
