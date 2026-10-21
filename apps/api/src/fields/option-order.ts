import { asc } from 'drizzle-orm';
import { selectOptions } from '../db/schema';

/**
 * #961 — THE order of a choice field's options. One position is the sort order (`sortExpr` ranks by it), the board's
 * "Field order" columns (the web builds them from the options as the API serves them) and every list of options.
 *
 * `id` is only the tie-break: positions are dense and unique (0..n-1) after the backfill and on every write path, so a tie
 * should not occur. It is here so that if one ever does, every reader still agrees on the order instead of each taking
 * whatever the database happened to return, which is what made two equal positions look "random".
 */
export const OPTION_ORDER = [asc(selectOptions.position), asc(selectOptions.id)];
