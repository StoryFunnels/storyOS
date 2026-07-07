import { Module } from '@nestjs/common';
import { InvitesService } from './invites.service';
import { MembersService } from './members.service';
import { SpacesService } from './spaces.service';
import { WorkspaceAccessGuard } from './workspace-access.guard';
import {
  InviteAcceptController,
  WorkspaceController,
  WorkspacesController,
} from './workspaces.controller';
import { WorkspacesService } from './workspaces.service';

@Module({
  controllers: [WorkspacesController, WorkspaceController, InviteAcceptController],
  providers: [
    WorkspacesService,
    SpacesService,
    MembersService,
    InvitesService,
    WorkspaceAccessGuard,
  ],
  exports: [WorkspaceAccessGuard],
})
export class WorkspacesModule {}
