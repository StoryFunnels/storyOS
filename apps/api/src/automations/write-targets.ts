import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { DatabasesService } from '../databases/databases.service';
import type { Membership } from '../workspaces/workspace-access.guard';

/** One wording whether the database is missing or merely out of reach, so the refusal reveals nothing about which. */
export const ACTION_TARGET_REFUSAL = "This action writes records into a database you can't add records to.";

/**
 * Ticket #1050 — every database an action list writes into (besides its own) needs at least `contributor` from the person
 * saving the rule or pressing the button: the same rung that adding a record there by hand needs.
 */
export async function assertCanWriteTargets(
  databases: DatabasesService,
  membership: Membership,
  targetDatabaseIds: string[],
): Promise<void> {
  for (const id of targetDatabaseIds) {
    try {
      await databases.assertAccess(membership, id, 'contributor');
    } catch (error) {
      if (error instanceof NotFoundException || error instanceof ForbiddenException) {
        throw new ForbiddenException(ACTION_TARGET_REFUSAL);
      }
      throw error;
    }
  }
}
