import { describe, expect, it } from 'vitest';
import { NON_TOGGLABLE } from './view-toolbar';
import { HIDDEN_TYPES } from '../table-view/table-view';

/**
 * #408 — "Created at / Updated at can't be hidden".
 *
 * REPRODUCED FIRST, per the ticket's own first acceptance criterion, and it does
 * NOT reproduce. On a fresh single-field database both timestamps appear in Hide
 * fields, clicking one removes the column, and the choice survives a reload —
 * verified in a live browser, which is also where the report came from.
 *
 * Neither candidate cause was real. They are not missing from `togglable`
 * (they are real `isSystem` field rows the API returns for every database, so
 * they are in `fields`), and the id round-trips fine.
 *
 * What WAS real is the stale comment on `NON_TOGGLABLE` claiming "system
 * timestamps never render in grids or on cards" — flatly contradicted by the
 * screenshot, and the likely reason the ticket was filed. That is corrected.
 *
 * These tests exist so the feared behaviour cannot quietly become true later.
 */

/** The types a table actually draws as a column, given the two lists. */
const RENDERED_SYSTEM_TYPES = ['created_at', 'updated_at'];

describe('#408 — every column the table renders can be turned off', () => {
  it('the timestamps are NOT excluded from toggling', () => {
    /*
     * The regression that matters. Adding 'created_at' to NON_TOGGLABLE — which
     * the old comment implied was already the case — would recreate exactly the
     * bug this ticket describes: a column that renders and cannot be hidden.
     */
    for (const type of RENDERED_SYSTEM_TYPES) {
      expect(NON_TOGGLABLE.has(type), `${type} must stay hideable`).toBe(false);
    }
  });

  it('the timestamps ARE rendered as columns — which is why they must be hideable', () => {
    // The pair is the point: rendered AND togglable. Either alone is fine;
    // rendered-but-not-togglable is the defect.
    for (const type of RENDERED_SYSTEM_TYPES) {
      expect(HIDDEN_TYPES.has(type), `${type} is drawn as a column`).toBe(false);
    }
  });

  it('nothing is both RENDERED and NON-TOGGLABLE, except the title', () => {
    /*
     * The invariant the ticket actually asks for: the relationship between what
     * renders and what can be turned off, asserted in one place instead of being
     * spread across two lists and a special case.
     *
     * `title` is the deliberate exception — hiding it would leave rows with
     * nothing to identify them.
     */
    const renderedButLocked = [...NON_TOGGLABLE].filter((t) => !HIDDEN_TYPES.has(t) && t !== 'title');
    expect(
      renderedButLocked,
      'these types are drawn as columns but cannot be turned off — that is #408',
    ).toEqual([]);
  });

  it('created_by is excluded from BOTH — consistent, not an oversight', () => {
    // A toggle that cannot change what you see is worse than no toggle, so a
    // type the table does not render must not appear in the Hide-fields list.
    expect(HIDDEN_TYPES.has('created_by')).toBe(true);
    expect(NON_TOGGLABLE.has('created_by')).toBe(true);
  });
});
