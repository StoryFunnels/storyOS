import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { FastifyRequest } from 'fastify';

/** Rate limits key on the credential (PAT/session token) rather than the IP. */
@Injectable()
export class ApiThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(req: Record<string, unknown>): Promise<string> {
    const request = req as unknown as FastifyRequest;
    const auth = request.headers.authorization;
    if (typeof auth === 'string' && auth.length > 0) return auth;
    const cookie = request.headers.cookie;
    if (typeof cookie === 'string' && cookie.length > 0) return cookie;
    return request.ip ?? 'anonymous';
  }
}
