import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { AuthGuard } from '../../auth/auth.guard';
import { WorkspaceAccessGuard } from '../../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../../workspaces/workspace-access.guard';
import { TyronThreadsService } from './threads.service';
import { TyronService } from './tyron.service';

class CreateThreadDto extends createZodDto(
  z.object({
    /** Used to auto-name the thread (#359). Optional — a thread may be opened empty. */
    first_message: z.string().max(10_000).optional(),
  }),
) {}

class RenameThreadDto extends createZodDto(
  z.object({ title: z.string().trim().min(1).max(200) }),
) {}

class TakeTurnDto extends createZodDto(
  z.object({ message: z.string().trim().min(1).max(10_000) }),
) {}

/**
 * #357d — a BOOLEAN only. The pending call lives server-side, so the client
 * cannot answer a different question than the one it was asked.
 */
class ConfirmDto extends createZodDto(z.object({ approve: z.boolean() })) {}

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
  constructor(
    private readonly threads: TyronThreadsService,
    private readonly tyron: TyronService,
  ) {}

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

  /**
   * #357c — say something to Tyron and get the outcome.
   *
   * One request, one outcome. NOT a stream: #357 asks for "an animation while
   * working, then a plain statement of what changed", which a spinner plus a
   * final answer satisfies exactly. #363 is where a progress line is genuinely
   * required, and `runTurn` is already an async generator, so that ticket can
   * stream the same loop without reshaping this endpoint.
   */
  @Post(':thread/turns')
  @ApiOperation({ summary: 'Send a message to Tyron and get what it did (#357)' })
  takeTurn(
    @Req() req: WorkspaceRequest,
    @Param('thread') thread: string,
    @Body() body: TakeTurnDto,
  ) {
    return this.tyron.takeTurn(req.membership, thread, body.message);
  }

  /**
   * #357d — answer Tyron's outstanding question.
   *
   * The counterpart to #358's classifier: without this a delete ends the turn as
   * a question nobody can answer, and the confirmation is decorative.
   */
  @Post(':thread/confirm')
  @ApiOperation({ summary: "Approve or decline Tyron's pending action (#358)" })
  confirm(
    @Req() req: WorkspaceRequest,
    @Param('thread') thread: string,
    @Body() body: ConfirmDto,
  ) {
    return this.tyron.confirmPending(req.membership, thread, body.approve);
  }
}
