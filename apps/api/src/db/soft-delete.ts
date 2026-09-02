import { isNull } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';

/**
 * #453 — the ONE predicate every soft-deleted read filters through, for
 * `databases`/`views`/`spaces` (and available to the pre-existing
 * `fields`/`records`/`spaceDocuments`/`comments` too). A thin wrapper reads
 * as unnecessary until the alternative is 40+ call sites each typing
 * `isNull(x.deletedAt)` by hand — which is exactly the "one concept, several
 * drifting copies" defect this codebase has shipped repeatedly (#375, #380,
 * #383, #399, #408, #422). One import, one behavior to change later.
 */
export function notDeleted(deletedAtColumn: PgColumn) {
  return isNull(deletedAtColumn);
}
