import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { env } from '../config/env';
import { RecordsService } from './records.service';

/**
 * #884 — computes `records.title_local` for rows that predate it. Fire-and-forget at boot (never blocks startup, a failure
 * is a gap to notice and retry), skipped under test, the same shape as the Members boot backfill. Until a row is reached a
 * narrowed reader sees `#<number>` for it, so a slow or failed backfill can only ever show LESS, never the full title.
 */
@Injectable()
export class TitleLocalBackfillSubscriber implements OnModuleInit {
  private readonly logger = new Logger(TitleLocalBackfillSubscriber.name);

  constructor(private readonly records: RecordsService) {}

  onModuleInit(): void {
    if (env().NODE_ENV === 'test') return;
    void this.records
      .backfillLocalTitles()
      .then((r) => this.logger.log(`title_local backfill: ${r.records} record(s) across ${r.databases} database(s)`))
      .catch((error) => this.logger.warn(`title_local backfill failed: ${String(error)}`));
  }
}
