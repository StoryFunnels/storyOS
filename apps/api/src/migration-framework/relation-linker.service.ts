import { Injectable } from '@nestjs/common';
import { RelationsService } from '../relations/relations.service';

/**
 * Thin wrapper over `RelationsService.addLinks` that turns a failed link into a
 * warning message instead of a silently swallowed `.catch(() => undefined)` —
 * every existing importer had exactly that silent-drop bug (ADR-0013). Only
 * ever *calls* relations.service.ts — never edits it, since it's a CLAUDE.md
 * hotspot file (one in-flight branch per hotspot).
 */
@Injectable()
export class RelationLinkerService {
  constructor(private readonly relationsService: RelationsService) {}

  /** Returns a warning message on failure, `null` on success or when there was nothing to link. */
  async link(
    workspaceId: string,
    databaseId: string,
    recordId: string,
    fieldId: string,
    targetIds: string[],
    actorId: string,
  ): Promise<string | null> {
    if (targetIds.length === 0) return null;
    try {
      await this.relationsService.addLinks(workspaceId, databaseId, recordId, fieldId, targetIds, actorId);
      return null;
    } catch (error) {
      return `link failed: ${(error as Error).message}`;
    }
  }
}
