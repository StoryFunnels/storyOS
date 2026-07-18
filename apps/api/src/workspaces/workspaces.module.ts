import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module';
import { FoldersController } from '../spaces/folders.controller';
import { FoldersService } from '../spaces/folders.service';
import { InvitesService } from './invites.service';
import { MembersService } from './members.service';
import { OnboardingController } from './onboarding.controller';
import { SpacesService } from './spaces.service';
import { WorkspaceAccessGuard } from './workspace-access.guard';
import {
  InviteAcceptController,
  WorkspaceController,
  WorkspacesController,
} from './workspaces.controller';
import { WorkspacesService } from './workspaces.service';

@Module({
  imports: [BillingModule],
  controllers: [WorkspacesController, WorkspaceController, InviteAcceptController, FoldersController, OnboardingController],
  providers: [
    WorkspacesService,
    SpacesService,
    MembersService,
    InvitesService,
    FoldersService,
    WorkspaceAccessGuard,
  ],
  exports: [WorkspaceAccessGuard, SpacesService, WorkspacesService],
})
export class WorkspacesModule {}
