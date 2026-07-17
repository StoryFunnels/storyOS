import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { MinRole, WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import { ArchitectService } from './architect.service';

const proposeSchema = z.object({
  /** The plain-language goal, e.g. "when a lead arrives, draft a reply and follow up". */
  goal: z.string().min(1).max(2000),
});
class ProposeDto extends createZodDto(proposeSchema) {}

/**
 * The plan comes back in as `unknown` and is validated inside the service.
 *
 * Deliberate: a DTO-level parse would reject a malformed plan with a 400 from
 * the pipe, losing the chance to say *which* part of the plan is wrong — and the
 * contract for this endpoint is a 422 with issues a reviewer can act on. The
 * plan is re-validated at exactly one boundary, `ArchitectService.build`.
 * `.optional()` for the same reason: an absent plan is a malformed plan, and it
 * deserves the service's answer rather than the pipe's generic one.
 */
const buildSchema = z.object({ plan: z.unknown().optional() });
class BuildDto extends createZodDto(buildSchema) {}

/**
 * The Architect (#213 / #214, ADR-0010 §6 —
 * docs/decisions/ADR-0010-agentic-os-engine.md).
 *
 * Two endpoints with a human in between, which is the whole design: `propose`
 * writes nothing and hands back a plan to read; `build` takes the approved plan
 * and creates it through the ordinary CRUD services. Admin-gated like the agents
 * controller — building a workflow is schema work.
 */
@ApiTags('agents')
@UseGuards(AuthGuard, WorkspaceAccessGuard)
@MinRole('admin')
@Controller('workspaces/:ws/architect')
export class ArchitectController {
  constructor(private readonly architect: ArchitectService) {}

  /**
   * Propose a plan from a goal (#213). **Builds nothing** — this is a read of
   * the workspace plus a plan to review. Each database in it is marked
   * create-new or reuse-existing against what is actually there.
   *
   * 422 if the Architect has no template for the goal: it matches against a
   * small scenario library rather than interpreting language (see
   * architect-proposer.ts), and pretending otherwise would be worse than a
   * clear refusal.
   */
  @Post('propose')
  @ApiOperation({ summary: 'Propose a plan from a plain-language goal; creates nothing' })
  propose(@Req() req: WorkspaceRequest, @Body() body: ProposeDto) {
    return this.architect.propose(req.membership, body.goal);
  }

  /**
   * Build an approved plan (#214).
   *
   * Everything it creates — databases, fields, states, relations, the agent
   * records, the bindings — goes through the same services a person's HTTP
   * client does, and is ordinary hand-editable config afterwards. Reuses rather
   * than duplicates anything already there; 422 (not a crash) if the plan
   * reuses a database that has since vanished.
   */
  @Post('build')
  @ApiOperation({ summary: 'Build an approved plan through the ordinary CRUD services' })
  build(@Req() req: WorkspaceRequest, @Body() body: BuildDto) {
    return this.architect.build(req.membership, body.plan);
  }
}
