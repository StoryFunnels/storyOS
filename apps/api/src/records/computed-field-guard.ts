/**
 * Ticket #1314 — a computed field (rollup, lookup, formula) that cannot be computed must never take the listing down with it.
 *
 * One filtered rollup whose query failed made EVERY read of its database return a server error, for every user, with nothing
 * visible at the moment the field was created. A computed cell is derived data, so the right answer to "could not compute" is an
 * empty cell, not a failed page. This is the ONE place that decides what happens then, so rollup, lookup and formula share it:
 *
 *  - the field's cells read as `null` (the caller does that, using `nullCells`),
 *  - the failure is logged ONCE per field per process (a 3,000-row database lists many times a minute: a line per request
 *    would bury the log), and
 *  - the log line carries the field id, its type and the database's own error text only: never a row, a title, or a value.
 */
export interface GuardLogger {
  warn(message: string): void;
}

export interface ComputedFieldRef {
  id: string;
  type: string;
}

/** The error text that is safe to log: the driver's own message (a missing column, a bad cast), never the query or its params. */
export function safeErrorText(err: unknown): string {
  let message = 'unknown error';
  let depth = 0;
  for (
    let cur: unknown = err;
    cur != null && typeof cur === 'object' && depth < 5;
    cur = (cur as { cause?: unknown }).cause
  ) {
    const e = cur as { code?: unknown; message?: unknown };
    if (typeof e.code === 'string' && typeof e.message === 'string') {
      message = e.message;
      break;
    }
    if (depth === 0 && cur instanceof Error) message = cur.constructor.name;
    depth++;
  }
  return message.replace(/\s+/g, ' ').slice(0, 200);
}

export class ComputedFieldFailures {
  private readonly seen = new Set<string>();

  constructor(private readonly logger: GuardLogger) {}

  /** Records one failure; returns true when this call wrote the log line (the first for that field). */
  report(def: ComputedFieldRef, err: unknown): boolean {
    if (this.seen.has(def.id)) return false;
    this.seen.add(def.id);
    this.logger.warn(
      `computed ${def.type} field ${def.id} could not be computed; its cells read as empty until it is fixed (${safeErrorText(err)})`,
    );
    return true;
  }
}

/** Sets a field's cell to null on every record: the shape of a computed cell that has no value. */
export function nullCells(
  records: Array<{ values: Record<string, unknown> }>,
  apiName: string,
): void {
  for (const record of records) record.values[apiName] = null;
}
