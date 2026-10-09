import { Injectable } from '@nestjs/common';
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import { from, mergeMap } from 'rxjs';
import type { Observable } from 'rxjs';
import { MentionNarrowingService } from './mention-narrowing.service';
import type { Membership } from '../workspaces/workspace-access.guard';

/**
 * #857 — THE single place rich text leaves the server as JSON for a restricted caller.
 *
 * Every JSON response to a workspace GUEST is walked once; any record mention (BlockNote chip
 * or legacy comment segment) whose target the guest cannot read is replaced by one fixed
 * placeholder. Doing it here, not per endpoint, is the point: the same chip shape comes back
 * from the record, its document, the list, every version preview, comments, search and the
 * MCP/Tyron reads, and a fix at each of those is a copy that drifts (#845's lesson).
 *
 * Admins and members never reach the walk, so stored content and their view of it are
 * unchanged; nothing is rewritten at rest. Streamed bodies (CSV) are not JSON and call
 * `MentionNarrowingService` directly — see its doc.
 */
@Injectable()
export class MentionNarrowingInterceptor implements NestInterceptor {
  constructor(private readonly narrowing: MentionNarrowingService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const membership = context.switchToHttp().getRequest<{ membership?: Membership }>().membership;
    if (!membership || membership.role !== 'guest') return next.handle();
    return next.handle().pipe(mergeMap((body) => from(this.narrowing.narrow(membership, body))));
  }
}
