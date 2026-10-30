import { Body, Controller, HttpCode, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { runnerPairSchema, runnerReportSchema, wakeClaimSchema, wakeCompleteSchema, wakeLeaseSchema } from './runner.dto';
import { RUNNER_PROTOCOL_MAX, RUNNER_PROTOCOL_MIN } from './runner.constants';
import { AgentWakesService } from './agent-wakes.service';
import { RunnerAuthGuard } from './runner-auth.guard';
import type { RunnerRequest } from './runner-auth.guard';
import { RunnersService } from './runners.service';

class RunnerPairDto extends createZodDto(runnerPairSchema) {}
class RunnerHeartbeatDto extends createZodDto(runnerReportSchema) {}
class WakeClaimDto extends createZodDto(wakeClaimSchema) {}
class WakeLeaseDto extends createZodDto(wakeLeaseSchema) {}
class WakeCompleteDto extends createZodDto(wakeCompleteSchema) {}

/**
 * The Runner program's own surface (ADR-0021 §2-3, §8): `/api/v1/runner/v1/*`. It authenticates with a Runner token, or for `pair`
 * with the code alone, and has no MCP tool by design: a model must not pair a machine or answer as one. Everything the person does
 * in the app lives in `RunnersController`, which a Runner token cannot reach (and which this controller's routes cannot be reached
 * through either).
 *
 * The claim, lease heartbeat and completion endpoints (ticket #1130) are here too, behind the same guard.
 */
@ApiTags('runner')
@Controller('runner/v1')
export class RunnerApiController {
  constructor(
    private readonly runners: RunnersService,
    private readonly wakes: AgentWakesService,
  ) {}

  @Post('pair')
  @HttpCode(201)
  // The defence is the lockout in RunnersService (wrong guesses per address, and overall), not a per-route throttle: the global
  // per-address budget still applies, and a flood of wrong codes stops costing a lookup after the fifth.
  @ApiOperation({
    summary:
      'Exchange a pairing code for a Runner token. The Runner is PENDING: it does nothing until the person presses Done in StoryOS, and is revoked if that does not happen inside the pairing window. The token is shown once.',
  })
  pair(@Req() req: FastifyRequest, @Body() body: RunnerPairDto) {
    return this.runners.exchange(body, req.ip ?? 'unknown');
  }

  @Post('heartbeat')
  @HttpCode(200)
  @UseGuards(RunnerAuthGuard)
  @ApiOperation({
    summary:
      'Report liveness, machine name, tools and versions. Answers with the supported protocol range and the agents assigned to THIS Runner. A Runner below the minimum protocol gets 426 with the one command that updates it.',
  })
  heartbeat(@Req() req: RunnerRequest, @Body() body: RunnerHeartbeatDto) {
    return this.runners.heartbeat(req.runner, body);
  }

  /**
   * The long-poll claim (ADR-0021 §2). Answers `200 {wakes: [...]}` with up to `max` wakes for the agents assigned to THIS Runner,
   * or `204` after up to 25 s with nothing. The claim is atomic: two concurrent claims never get the same wake. With `wake_id` a
   * wake that is already claimed is a clear `409 wake_already_claimed`.
   */
  @Post('claim')
  @HttpCode(200)
  @UseGuards(RunnerAuthGuard)
  @ApiOperation({
    summary:
      'Long-poll for wakes for the agents assigned to this Runner. 200 with the claimed wakes (each with a 90-second lease and a nonce), or 204 when there is nothing. Atomic: a wake is handed to exactly one claim. 409 wake_already_claimed if wake_id names one that is taken.',
  })
  async claim(@Req() req: RunnerRequest, @Res({ passthrough: true }) reply: FastifyReply, @Body() body: WakeClaimDto) {
    await this.wakes.touch(req.runner);
    const wakes = await this.wakes.claim(req.runner, { max: body.max, waitSeconds: body.wait_seconds, wakeId: body.wake_id });
    if (wakes.length === 0) {
      reply.status(204);
      return;
    }
    return { wakes, protocol: { minimum: RUNNER_PROTOCOL_MIN, maximum: RUNNER_PROTOCOL_MAX } };
  }

  @Post('wakes/:id/heartbeat')
  @HttpCode(200)
  @UseGuards(RunnerAuthGuard)
  @ApiOperation({
    summary:
      'Renew the lease on a wake this Runner holds (every 30 s). Also a liveness signal. 409 lease_lost if the lease lapsed, the run was cancelled or the wake was taken back: kill the session and discard its result.',
  })
  leaseHeartbeat(@Req() req: RunnerRequest, @Param('id') id: string, @Body() body: WakeLeaseDto) {
    return this.wakes.heartbeat(req.runner, id, body.nonce);
  }

  @Post('wakes/:id/complete')
  @HttpCode(200)
  @UseGuards(RunnerAuthGuard)
  @ApiOperation({
    summary:
      'Report the adapter result for a wake this Runner holds. Idempotent on (id, nonce): a retry after a dropped response gets the same answer. Writes the Run, ends the wake, and enqueues one fresh wake if a repeat arrived mid-run.',
  })
  complete(@Req() req: RunnerRequest, @Param('id') id: string, @Body() body: WakeCompleteDto) {
    return this.wakes.complete(req.runner, id, body);
  }
}
