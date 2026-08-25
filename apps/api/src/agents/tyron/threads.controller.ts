import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { AuthGuard } from '../../auth/auth.guard';
import { WorkspaceAccessGuard } from '../../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../../workspaces/workspace-access.guard';
import { TyronThreadsService } from './threads.service';

class CreateThreadDto extends createZodDto(
  z.object({
    /** Used to auto-name the thread (#359). Optional — a thread may be opened empty. */
    first_message: z.string().max(10_000).optional(),
  }),
) {}

class RenameThreadDto extends createZodDto(
  z.object({ title: z.string().trim().min(1).max(200) }),
) {}

/**
 * Tyron threads (#359).
 *
 * No admin route and no workspace-wide list, deliberately: every endpoint is
 * scoped to the calling member by the service, and adding an "all threads" read
 * would be the first crack in "private, including from admins" (#290).
 */
@ApiTags('tyron')
@ApiBearerAuth()
@UseGuards(AuthGuard, WorkspaceAccessGuard)
@Controller('workspaces/:ws/tyron/threads')
export class TyronThreadsController {
  constructor(private readonly threads: TyronThreadsService) {}

  @Get()
  @ApiOperation({ summary: "The caller's own Tyron threads, most recent first (#359)" })
  list(@Req() req: WorkspaceRequest) {
    return this.threads.list(req.membership);
  }

  @Post()
  @ApiOperation({ summary: 'Start a thread, auto-named from its first message (#359)' })
  create(@Req() req: WorkspaceRequest, @Body() body: CreateThreadDto) {
    return this.threads.create(req.membership, body.first_message);
  }

  @Get(':thread')
  @ApiOperation({ summary: 'One thread with its history (404 unless it is yours)' })
  get(@Req() req: WorkspaceRequest, @Param('thread') thread: string) {
    return this.threads.get(req.membership, thread);
  }

  @Patch(':thread')
  @ApiOperation({ summary: 'Rename a thread' })
  rename(@Req() req: WorkspaceRequest, @Param('thread') thread: string, @Body() body: RenameThreadDto) {
    return this.threads.rename(req.membership, thread, body.title);
  }

  @Delete(':thread')
  @ApiOperation({ summary: 'Delete a thread — does NOT undo what it did (#359)' })
  remove(@Req() req: WorkspaceRequest, @Param('thread') thread: string) {
    return this.threads.remove(req.membership, thread);
  }
}
