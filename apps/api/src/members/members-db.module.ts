import { Module } from '@nestjs/common';
import { DatabasesModule } from '../databases/databases.module';
import { FieldsModule } from '../fields/fields.module';
import { RecordsModule } from '../records/records.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { MembersDbService } from './members-db.service';
import { MembersProjectionSubscriber } from './members-projection.subscriber';

/**
 * The Members system database (#128 Phase 1) — a per-workspace, one-way
 * projection of workspace memberships (people-in-this-workspace, including
 * guests). Provisions the "Members" database as records via the shared
 * spaces/databases/fields/records services, exactly like AgentsModule
 * provisions the Agentic OS pack.
 *
 * This module sits ABOVE `WorkspacesModule` in the import graph
 * (Databases/Records/Fields all import Workspaces), which is why the membership
 * mutation points in WorkspacesModule notify it through the `@Global`
 * membership-event bus (`MembershipEventsService`) rather than a direct call — a
 * direct dependency the other way would be a cycle. The bus needs no import
 * here; the subscriber just subscribes.
 */
@Module({
  imports: [DatabasesModule, FieldsModule, RecordsModule, WorkspacesModule],
  providers: [MembersDbService, MembersProjectionSubscriber],
  exports: [MembersDbService],
})
export class MembersDbModule {}
