import { Body, Controller, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import type { FastifyRequest } from 'fastify';
import { runnerPairSchema, runnerReportSchema } from './runner.dto';
import { RunnerAuthGuard } from './runner-auth.guard';
import type { RunnerRequest } from './runner-auth.guard';
import { RunnersService } from './runners.service';

class RunnerPairDto extends createZodDto(runnerPairSchema) {}
class RunnerHeartbeatDto extends createZodDto(runnerReportSchema) {}

/**
 * The Runner program's own surface (ADR-0021 §2-3, §8): `/api/v1/runner/v1/*`. It authenticates with a Runner token, or for `pair`
 * with the code alone, and has no MCP tool by design: a model must not pair a machine or answer as one. Everything the person does
 * in the app lives in `RunnersController`, which a Runner token cannot reach (and which this controller's routes cannot be reached
 * through either).
 *
 * The claim, lease heartbeat and completion endpoints are ticket #1130's; they join this controller and its guard.
 */
@ApiTags('runner')
@Controller('runner/v1')
export class RunnerApiController {
  constructor(private readonly runners: RunnersService) {}

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
}
