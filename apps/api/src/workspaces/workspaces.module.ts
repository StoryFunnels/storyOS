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
import { ActivationService } from './activation.service';
import { AiConnectionsController } from './ai-connections.controller';
import { AiConnectionsService } from './ai-connections.service';
import { WorkspaceActivationEventsService } from './workspace-activation-events.service';
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
    AiConnectionsController,
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
    ActivationService,
    AiConnectionsService,
    WorkspaceActivationEventsService,
  ],
  // ActivationService (#980): the ONE definition of "an AI client is connected", read by the checklist, the activation event and
  // the agent-run on-ramp step.
  exports: [WorkspaceAccessGuard, SpacesService, WorkspacesService, ActivationService],
})
export class WorkspacesModule {}
