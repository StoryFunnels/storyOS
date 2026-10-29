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

  /**
   * #1103 — make a record's links on one field EQUAL `targetIds` (removing what is no longer wanted), for a source that
   * owns the field. Writes nothing when the set is already equal, so a re-sync of an unchanged record adds no link events.
   * `link()` above only adds, which left a dropped label or a changed cycle linked forever.
   */
  async set(
    workspaceId: string,
    databaseId: string,
    recordId: string,
    fieldId: string,
    targetIds: string[],
    actorId: string,
  ): Promise<string | null> {
    try {
      const current = (await this.relationsService.listLinks(databaseId, recordId, fieldId)).data.map((r) => r.id);
      const want = new Set(targetIds);
      if (current.length === want.size && current.every((id) => want.has(id))) return null;
      await this.relationsService.replaceLinks(workspaceId, databaseId, recordId, fieldId, [...want], actorId);
      return null;
    } catch (error) {
      return `link failed: ${(error as Error).message}`;
    }
  }
}
