import { Module } from '@nestjs/common';
import { AutomationsModule } from '../automations/automations.module';
import { BillingModule } from '../billing/billing.module';
import { DatabasesModule } from '../databases/databases.module';
import { RunsController } from './runs.controller';
import { RunsService } from './runs.service';

/**
 * MN-264 — the workspace-wide Runs & health surface. Deliberately its own
 * module rather than folded into AutomationsModule: automations.module.ts is
 * per-database-scoped CRUD (`workspaces/:ws/databases/:db/automations`),
 * while this is a workspace-scoped read (+ rerun) surface spanning every
 * database's rules at once — a different resource shape, same underlying
 * tables. Imports AutomationsModule for JobRunnerService (rerun's enqueue),
 * DatabasesModule for the same per-rule access check the automations
 * controller itself uses, and BillingModule for the quota header's read of
 * EntitlementsService (MN-168) — no new metering, just exposing what already
 * exists workspace-scoped instead of per-capability.
 */
@Module({
  imports: [AutomationsModule, DatabasesModule, BillingModule],
  controllers: [RunsController],
  providers: [RunsService],
})
export class RunsModule {}
