import { Injectable } from '@nestjs/common';
import { RecordsService } from '../records/records.service';

export const DEFAULT_CHUNK_SIZE = 500;

/** Pure chunking helper — split into unit tests without booting Nest. */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export interface ChunkedApplyProgress {
  processed: number;
  total: number;
  chunk: number;
  totalChunks: number;
}

/**
 * Chunked, progress-reporting record creation shared by every importer
 * (ADR-0013 §3) — generalizes MN-052's inline
 * `for (offset...) createBatch` loop so a new source gets safe batch sizing
 * and a real progress callback for free instead of re-deriving it. Always
 * suppresses automations (imports never fire them — MN-047's contract).
 */
@Injectable()
export class ChunkedApplyService {
  constructor(private readonly recordsService: RecordsService) {}

  async createChunked(
    workspaceId: string,
    databaseId: string,
    payloads: Array<Record<string, unknown>>,
    actorId: string | null,
    options: { chunkSize?: number; onProgress?: (progress: ChunkedApplyProgress) => void } = {},
  ): Promise<string[]> {
    const chunks = chunk(payloads, options.chunkSize ?? DEFAULT_CHUNK_SIZE);
    const createdIds: string[] = [];
    for (const [i, batch] of chunks.entries()) {
      if (batch.length === 0) continue;
      const created = await this.recordsService.createBatch(workspaceId, databaseId, batch, actorId, 0, {
        suppressAutomations: true,
      });
      created.forEach((r) => createdIds.push(r.id));
      options.onProgress?.({
        processed: createdIds.length,
        total: payloads.length,
        chunk: i + 1,
        totalChunks: chunks.length,
      });
    }
    return createdIds;
  }
}
