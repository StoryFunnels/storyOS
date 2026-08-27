import { describe, expect, it } from 'vitest';
import { classifyWrite } from './write-safety';
import { BULK_CHECKIN_THRESHOLD } from './ceilings';

/**
 * #358. The ticket is explicit that tests must cover BOTH directions:
 *
 * > Tests cover BOTH directions: every confirmation fires when it should, AND
 * > ordinary edits still pass straight through untouched. The second half is
 * > what stops a later 'safety' change from making Tyron useless.
 *
 * That second half is the one that gets dropped, so it comes first here.
 */
describe('ordinary writes are NOT interrupted — the half that keeps Tyron usable', () => {
  /**
   * The founder's rule is "write easily, delete only after a commitment". A
   * confirmation on every write would make Tyron slower than doing the job by
   * hand, which removes the reason to use it at all.
   */
  it.each([
    'create_record',
    'update_record',
    'add_field',
    'update_field',
    'change_field_type',
    'link_records',
    'unlink_records',
    'create_relation',
    'create_view',
    'update_view',
    'create_database',
    'update_database',
    'create_space',
    'add_comment',
    'attach_file',
    'reorder_fields',
    'reorder_views',
    'update_record_description',
    'create_automation',
    'update_automation',
  ])('proceeds without asking: %s', (tool) => {
    expect(classifyWrite({ tool })).toEqual({ kind: 'proceed' });
  });

  it('a small bulk edit is still ordinary', () => {
    // Under the threshold is not "a bulk edit" — it is just work.
    expect(classifyWrite({ tool: 'update_record', affected: 3 }).kind).toBe('proceed');
    expect(classifyWrite({ tool: 'update_record', affected: BULK_CHECKIN_THRESHOLD }).kind).toBe('proceed');
  });

  it('reads are never gated', () => {
    for (const tool of ['query_records', 'get_record', 'search', 'describe_database', 'list_databases']) {
      expect(classifyWrite({ tool }).kind).toBe('proceed');
    }
  });
});

describe('deleting records — confirm, and say how many', () => {
  it('confirms, naming the count and the database', () => {
    const v = classifyWrite({ tool: 'delete_record', affected: 12, databaseName: 'Clients' });
    expect(v.kind).toBe('confirm');
    if (v.kind !== 'confirm') throw new Error('unreachable');
    expect(v.strength).toBe('normal');
    expect(v.message).toContain('12 records');
    expect(v.message).toContain('Clients');
  });

  it('reads correctly for a single record', () => {
    const v = classifyWrite({ tool: 'delete_record', affected: 1 });
    if (v.kind !== 'confirm') throw new Error('unreachable');
    // "Delete 1 records?" reads as a bug and undermines the number beside it.
    expect(v.message).toContain('1 record');
    expect(v.message).not.toContain('1 records');
  });
});

describe('deleting a field / database / relation — the STRONGER tier', () => {
  /**
   * #358's reasoning: dropping a column destroys data *invisibly*. The rows
   * remain and what was in that column is simply gone, with nothing on screen to
   * show it existed. Someone reading "delete field" can reasonably picture the
   * column being taken off the screen — so the wording has to correct that.
   */
  it.each(['delete_field', 'delete_database', 'delete_relation'])(
    'is strong and says the data is GONE, not hidden: %s',
    (tool) => {
      const v = classifyWrite({ tool, fieldName: 'Notes', databaseName: 'Clients' });
      expect(v.kind).toBe('confirm');
      if (v.kind !== 'confirm') throw new Error('unreachable');
      expect(v.strength).toBe('strong');
      expect(v.message).toMatch(/gone/i);
      // The distinction is the whole point of this tier.
      expect(v.message).toMatch(/not hidden|deleted/i);
    },
  );

  it('names the field being dropped, so the confirmation is checkable', () => {
    const v = classifyWrite({ tool: 'delete_field', fieldName: 'Notes', databaseName: 'Clients' });
    if (v.kind !== 'confirm') throw new Error('unreachable');
    expect(v.message).toContain('Notes');
    expect(v.message).toContain('Clients');
  });

  it('is stronger than a row delete — the two tiers are actually distinguishable', () => {
    const row = classifyWrite({ tool: 'delete_record', affected: 5 });
    const field = classifyWrite({ tool: 'delete_field', fieldName: 'Notes' });
    if (row.kind !== 'confirm' || field.kind !== 'confirm') throw new Error('unreachable');
    expect(row.strength).toBe('normal');
    expect(field.strength).toBe('strong');
  });
});

describe('bulk edits above the threshold', () => {
  /**
   * A silent bulk edit is as destructive as a delete, just quieter — "set every
   * client to Paused" is unrecoverable in practice even though nothing was
   * technically deleted.
   */
  it('confirms, stating how many rows and which field', () => {
    const v = classifyWrite({
      tool: 'update_record',
      affected: 1200,
      fieldName: 'Status',
      databaseName: 'Clients',
    });
    expect(v.kind).toBe('confirm');
    if (v.kind !== 'confirm') throw new Error('unreachable');
    expect(v.message).toContain('1200');
    expect(v.message).toContain('Status');
  });

  it('fires just above the threshold and not at it', () => {
    expect(classifyWrite({ tool: 'update_record', affected: BULK_CHECKIN_THRESHOLD }).kind).toBe('proceed');
    expect(classifyWrite({ tool: 'update_record', affected: BULK_CHECKIN_THRESHOLD + 1 }).kind).toBe('confirm');
  });

  /**
   * Shares the constant with the runtime, so a confirmation can never predict a
   * different count than the run actually pauses at.
   */
  it('uses the same threshold the runtime checks in at', () => {
    expect(BULK_CHECKIN_THRESHOLD).toBe(50);
  });
});

describe('outward actions reuse the EXISTING approval gate', () => {
  /**
   * #358: inventing a second gate would mean two things to configure and two
   * places to get it wrong. These classes mirror `APPROVAL_POLICY_KINDS` in
   * agent-runtime.ts rather than forming a second opinion about what counts as
   * outward.
   */
  it.each(['run_button', 'run_skill', 'send_email', 'send_message', 'post_social'])(
    'routes to the approval gate, not a confirmation: %s',
    (tool) => {
      expect(classifyWrite({ tool }).kind).toBe('approval_gate');
    },
  );

  it('an outward action is never downgraded to a plain confirm', () => {
    // Ordering matters: if the delete checks ran first, "delete and notify"
    // could be reduced to a delete confirmation and skip the gate entirely.
    const v = classifyWrite({ tool: 'send_email', affected: 1000 });
    expect(v.kind).toBe('approval_gate');
  });
});

describe('out of reach entirely in v1', () => {
  it.each([
    ['invite_member', /inviting people/i],
    ['update_permissions', /permissions/i],
    ['update_billing', /billing/i],
    ['cancel_subscription', /billing/i],
  ])('refuses %s with a plain reason', (tool, reason) => {
    const v = classifyWrite({ tool });
    expect(v.kind).toBe('refuse');
    if (v.kind !== 'refuse') throw new Error('unreachable');
    expect(v.message).toMatch(reason);
    // "I can't" with no reason reads as a malfunction rather than a boundary.
    expect(v.message.length).toBeGreaterThan(40);
  });

  it('a refusal is absolute — it is never re-described as confirmable', () => {
    // Refusals are checked first precisely so a refused action cannot be
    // reached by another branch and turned into a question.
    const v = classifyWrite({ tool: 'invite_member', affected: 500 });
    expect(v.kind).toBe('refuse');
  });
});

describe('unknown destructive tools — the fail-safe', () => {
  /**
   * Under ADR-0016 the tool catalog is discovered at RUNTIME, so a new tool can
   * genuinely arrive without anyone editing the classifier. The dangerous
   * default is silence: treating an unrecognised delete as ordinary would let it
   * through without a word.
   *
   * Naming is therefore treated as evidence. The cost of being wrong is one
   * unnecessary question; the cost of the opposite is silent data loss.
   */
  it.each(['delete_workspace', 'remove_everything', 'drop_table', 'purge_records', 'clear_history'])(
    'confirms an unrecognised destructive-sounding tool: %s',
    (tool) => {
      const v = classifyWrite({ tool });
      expect(v.kind).toBe('confirm');
      if (v.kind !== 'confirm') throw new Error('unreachable');
      expect(v.strength).toBe('strong');
      // Names the tool: an unrecognised destructive action is exactly the case
      // where the user should see precisely what was asked for.
      expect(v.message).toContain(tool);
    },
  );

  it('does NOT trip on ordinary tools that merely contain a scary word', () => {
    // `unlink_records` removes a LINK, not data, and is ordinary work. A prefix
    // match rather than a substring match is what keeps this from over-firing.
    expect(classifyWrite({ tool: 'unlink_records' }).kind).toBe('proceed');
    expect(classifyWrite({ tool: 'update_record' }).kind).toBe('proceed');
    expect(classifyWrite({ tool: 'undelete_record' }).kind).toBe('proceed');
  });
});

/**
 * #363 — a build must not halt on its own housekeeping.
 *
 * Found in a live browser: building a workspace from "we run a boutique bakery"
 * created databases, then replaced a default table view with a board — and the
 * build STOPPED, asking `"delete_view" looks like it removes something, and I
 * don't recognise it. Go ahead?`
 *
 * The catch-all was working exactly as designed. The gap was that a real, named,
 * known-safe tool had never been classified, so it fell through to the branch
 * that exists for tools nobody has thought about.
 */
describe('#363 deleting a view is not destructive', () => {
  it('proceeds, because a view is a lens and the records survive', () => {
    // ADR-0? / CLAUDE.md, verbatim: "deleting the view itself is safe".
    expect(classifyWrite({ tool: 'delete_view' })).toEqual({ kind: 'proceed' });
  });

  it('still stops for the deletes that DO destroy data', () => {
    // The set is one entry for a reason. These must not have moved.
    expect(classifyWrite({ tool: 'delete_field', fieldName: 'Notes' }).kind).toBe('confirm');
    expect(classifyWrite({ tool: 'delete_database', databaseName: 'Clients' }).kind).toBe('confirm');
    expect(classifyWrite({ tool: 'delete_record', affected: 1 }).kind).toBe('confirm');
    // A file is data, and deleting it destroys the only copy — it belongs in the
    // catch-all until someone classifies it deliberately.
    expect(classifyWrite({ tool: 'delete_attachment' }).kind).toBe('confirm');
  });

  it('keeps the catch-all working for tools nobody has classified', () => {
    const verdict = classifyWrite({ tool: 'delete_everything_forever' });
    expect(verdict.kind).toBe('confirm');
    expect('message' in verdict && verdict.message).toContain("don't recognise it");
  });
});
