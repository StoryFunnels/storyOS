import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { databases, records } from '../db/schema';
import { AccessService } from './access.service';
import { collectMentionedRecordIds, narrowMentions } from './mention-narrowing';
import type { Membership } from '../workspaces/workspace-access.guard';

/**
 * #857 — resolves WHICH mentioned records a caller may read, then redacts the rest (the pure
 * half is `mention-narrowing.ts`). Two callers, and only two, because there are only two ways
 * rich text leaves the server: `MentionNarrowingInterceptor` for every JSON response, and the
 * CSV export, whose body is a stream the interceptor cannot see. A new streamed or non-JSON
 * output that carries rich text MUST call `narrow` too, before it renders the value.
 *
 * "Readable" is the same `effectiveForRecords` three-way max every other guest read uses. A
 * mention whose target does not exist in this workspace (stale, foreign, deleted) is not in the
 * readable set, so it is redacted too. Admins and members are returned untouched.
 */
@Injectable()
export class MentionNarrowingService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly access: AccessService,
  ) {}

  async narrow<T>(membership: Membership | undefined, value: T): Promise<T> {
    if (!membership || membership.role !== 'guest') return value;
    const mentioned = collectMentionedRecordIds(value);
    if (mentioned.size === 0) return value;
    const rows = await this.db
      .select({ id: records.id, databaseId: records.databaseId, spaceId: databases.spaceId })
      .from(records)
      .innerJoin(databases, eq(databases.id, records.databaseId))
      .where(and(inArray(records.id, [...mentioned]), eq(databases.workspaceId, membership.workspaceId)));
    const roles = await this.access.effectiveForRecords(membership, rows);
    const readable = new Set(rows.filter((r) => roles.get(r.id)).map((r) => r.id));
    return narrowMentions(value, readable) as T;
  }
}
