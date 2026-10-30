import { Injectable, UnauthorizedException } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { RUNNER_TOKEN_PREFIX } from './runner.constants';
import type { RunnerRow } from './runner-present';
import { RunnersService } from './runners.service';

export type RunnerRequest = FastifyRequest & { runner: RunnerRow };

/**
 * The ONLY guard that accepts a Runner's credential, and it accepts nothing else: a session, a PAT or an OAuth connection on a
 * `/runner/v1/*` route is a 401, exactly as a Runner token on any other route is (AuthGuard names it). The two credentials never
 * meet (ADR-0021 §3): a leaked Runner token cannot read a record, and a leaked PAT cannot claim a wake.
 *
 * Resolution is live on every call: a revoked, cancelled or window-expired Runner, or one whose owner left the workspace, is
 * refused on the very next request with a sentence the Runner can print.
 */
@Injectable()
export class RunnerAuthGuard implements CanActivate {
  constructor(private readonly runners: RunnersService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const header = request.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith(`Bearer ${RUNNER_TOKEN_PREFIX}`)) {
      throw new UnauthorizedException('A Runner token is required here. Pair this Runner with `storyos-runner pair`.');
    }
    (request as RunnerRequest).runner = await this.runners.resolveToken(header.slice('Bearer '.length));
    return true;
  }
}
