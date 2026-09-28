import { Module } from '@nestjs/common';
import { ActionGatesModule } from '../action-gates/action-gates.module';
import { BillingModule } from '../billing/billing.module';
import { FoldersController } from '../spaces/folders.controller';
import { FoldersService } from '../spaces/folders.service';
import { GroupsController } from '../spaces/groups.controller';
import { GroupsService } from '../spaces/groups.service';
import { InvitesService } from './invites.service';
import { MembersService } from './members.service';
import { OnboardingController } from './onboarding.controller';
import { OnboardingNudgeService } from './onboarding-nudge.service';
import { SpacesService } from './spaces.service';
import { WorkspaceAccessGuard } from './workspace-access.guard';
import {
  InviteAcceptController,
  WorkspaceController,
  WorkspacesController,
} from './workspaces.controller';
import { WorkspacesService } from './workspaces.service';

@Module({
  // #542 — ActionGatesModule imports nothing itself, so this and
  // DatabasesModule can both import it directly with no cycle risk.
  imports: [BillingModule, ActionGatesModule],
  controllers: [
    WorkspacesController,
    WorkspaceController,
    InviteAcceptController,
    FoldersController,
    GroupsController,
    OnboardingController,
  ],
  providers: [
    WorkspacesService,
    SpacesService,
    MembersService,
    InvitesService,
    FoldersService,
    GroupsService,
    WorkspaceAccessGuard,
    OnboardingNudgeService,
  ],
  exports: [WorkspaceAccessGuard, SpacesService, WorkspacesService],
})
export class WorkspacesModule {}
