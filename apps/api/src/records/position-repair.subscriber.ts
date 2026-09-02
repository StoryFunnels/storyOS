import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { RecordsService } from './records.service';
import { env } from '../config/env';

/**
 * #487 — one-time, self-healing sweep for records.position collisions written
 * before migration 0082 fixed the column's collation. Nothing new can collide
 * after that migration; this exists only to repair rows already on disk,
 * wherever this code is deployed — including this very workspace's own
 * `records` table, which is exactly as exposed to the bug as anyone's.
 *
 * Same shape as MembersProjectionSubscriber's boot backfill: fire-and-forget,
 * isolated per database (one bad database never blocks the rest), skipped
 * under `NODE_ENV=test` where tests call `RecordsService.repairDuplicatePositions`
 * directly instead of paying a full-instance sweep on every test-app boot.
 * Idempotent — a database with no collisions costs one query and repairs zero
 * rows, so re-running on every deploy is safe and eventually a no-op forever.
 */
@Injectable()
export class PositionRepairSubscriber implements OnModuleInit {
  private readonly logger = new Logger(PositionRepairSubscriber.name);

  constructor(
    private readonly records: RecordsService,
    @Inject(DB) private readonly db: Db,
  ) {}

  onModuleInit(): void {
    if (env().NODE_ENV === 'test') return;
    void this.repairAll().catch((error) =>
      this.logger.warn(`Position repair boot sweep failed: ${String(error)}`),
    );
  }

  private async repairAll(): Promise<void> {
    // Every database uses the same records table and the same lastPosition()
    // anchor — a system database (Members, Agents, Runs, Triggers) is exactly
    // as exposed to the bug as any other, so none are excluded here.
    const all = await this.db.query.databases.findMany({ columns: { id: true } });
    let totalRepaired = 0;
    for (const database of all) {
      try {
        const repaired = await this.records.repairDuplicatePositions(database.id);
        totalRepaired += repaired;
        if (repaired > 0) {
          this.logger.log(`Position repair: ${repaired} row(s) re-keyed in database ${database.id}`);
        }
      } catch (error) {
        this.logger.warn(`Position repair failed for database ${database.id}: ${String(error)}`);
      }
    }
    if (totalRepaired > 0) {
      this.logger.log(`Position repair boot sweep: ${totalRepaired} row(s) re-keyed in total`);
    }
  }
}
