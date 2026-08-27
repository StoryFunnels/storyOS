import { BULK_CHECKIN_THRESHOLD } from './ceilings';

/**
 * Tyron's write safety (#358).
 *
 * The founder's rule, exactly: **write easily, delete only after a commitment.**
 * So this file is as much about what must NOT interrupt as what must. A
 * confirmation on every write would make Tyron slower than doing the work by
 * hand, which defeats the point of having it.
 *
 * **Permissions already do most of the work.** Tyron acts as the member
 * (ADR-0016 §1, ADR-0010 §2), so someone who cannot drop a database cannot ask
 * Tyron to. This layer sits ON TOP of that, for things the member *can* do but
 * probably did not mean to do at this scale.
 */

export type SafetyVerdict =
  /** Just do it. Values, new fields, new records, links. */
  | { kind: 'proceed' }
  /** Ask first. `strength` decides how hard the confirmation pushes back. */
  | { kind: 'confirm'; strength: 'normal' | 'strong'; message: string }
  /** Not Tyron's to do at all, in v1. */
  | { kind: 'refuse'; message: string }
  /**
   * Outward-facing. Goes through the approval gate the product ALREADY has
   * (ADR-0010 §4) — #358 is explicit that inventing a second gate would mean two
   * things to configure and two places to get it wrong.
   */
  | { kind: 'approval_gate'; message: string };

/**
 * Tools that destroy a CONTAINER rather than a row.
 *
 * These get the stronger confirmation because dropping a column destroys data
 * *invisibly*: the rows remain, and what was in that column is simply gone, with
 * nothing on screen to show it ever existed. That is worse than deleting a row
 * you can see, and the wording has to say so.
 */
const STRUCTURAL_DELETES = new Set(['delete_field', 'delete_database', 'delete_relation']);

/** Row-level deletes — confirm, but the loss is visible and countable. */
const RECORD_DELETES = new Set(['delete_record']);

/**
 * Deletes that destroy no DATA, so they do not stop to ask (#363).
 *
 * A view is a LENS. The personal-space ADR states it outright and CLAUDE.md
 * repeats it: "deleting the view itself is safe" — the records it showed are
 * untouched and every other view of them still works.
 *
 * These fell through to the `DESTRUCTIVE_NAME` catch-all below, which exists for
 * tools nobody has classified and says so: `"delete_view" looks like it removes
 * something, and I don't recognise it`. Found live during a #363 build — Tyron
 * replaced a default table view with a board, and the build HALTED on a
 * confirmation about its own housekeeping. An honest catch-all that keeps
 * catching a known-safe tool is a classification gap, not a safety feature.
 *
 * DELIBERATELY ONE ENTRY. `delete_view` is here because an ADR says so, not
 * because it sounds harmless — that is the bar for anything joining it.
 *
 * `delete_attachment` was in an earlier draft of this set and is wrong: a file
 * is data, and deleting it destroys the only copy. `delete_database` and
 * `delete_field` stay in STRUCTURAL_DELETES with the strong wording for the same
 * reason. A set that grows on vibes turns the catch-all into decoration.
 */
const SAFE_DELETES = new Set(['delete_view']);

/**
 * Out of Tyron's reach entirely in v1 (#358). Not assistant work, and the blast
 * radius is other PEOPLE rather than data.
 *
 * Note these are not currently in the MCP catalog, so today this is belt and
 * braces — listed anyway because the catalog is discovered at RUNTIME under
 * ADR-0016, so a tool added there arrives here without a code change. A refusal
 * that predates the tool is the only kind that cannot be forgotten.
 */
const OUT_OF_REACH: Record<string, string> = {
  invite_member: 'inviting people',
  remove_member: 'removing people',
  update_member_role: 'changing what someone can do',
  update_permissions: 'changing permissions',
  update_billing: 'anything to do with billing',
  cancel_subscription: 'anything to do with billing',
};

/**
 * Outward actions — they leave the workspace and reach a person.
 *
 * `run_button` and `run_skill` are here because either can be wired to send
 * something; the product already treats them as gated classes in
 * `APPROVAL_POLICY_KINDS` (agent-runtime.ts), and this mirrors that list rather
 * than inventing a second opinion about what counts as outward.
 */
const OUTWARD = new Set(['run_button', 'run_skill', 'send_email', 'send_message', 'post_social']);

/**
 * Deletes that this file does not know about yet.
 *
 * The dangerous default is silence: if a destructive tool is added to the
 * catalog later and this classifier has never heard of it, treating it as
 * ordinary would let it through without a word. Under ADR-0016 the catalog is
 * discovered at RUNTIME, so that is not hypothetical — a new tool genuinely can
 * arrive without anyone editing this file.
 *
 * So naming is treated as evidence. Anything that reads like a delete confirms,
 * even unrecognised. The cost of being wrong is one unnecessary question; the
 * cost of the opposite is silent data loss.
 */
const DESTRUCTIVE_NAME = /^(delete|remove|drop|purge|clear|destroy|truncate)_/;

export interface WriteIntent {
  tool: string;
  /** How many records this call would affect, when that is knowable up front. */
  affected?: number;
  /** For messages: which database, which field. Never guessed. */
  databaseName?: string;
  fieldName?: string;
}

/**
 * Classify one intended tool call.
 *
 * Order is deliberate and load-bearing:
 * refuse → outward → structural delete → record delete → bulk → proceed.
 *
 * Refusals come first because they are absolute; a refused action must not be
 * re-described as something confirmable. Outward comes before the delete checks
 * so that "delete and notify" cannot be reduced to a plain delete confirmation
 * and skip the approval gate.
 */
export function classifyWrite(intent: WriteIntent): SafetyVerdict {
  const { tool, affected, databaseName, fieldName } = intent;

  const outOfReach = OUT_OF_REACH[tool];
  if (outOfReach) {
    return {
      kind: 'refuse',
      // Explains WHY rather than just declining — #358 asks for a plain
      // explanation, and "I can't" without a reason reads as a malfunction.
      message:
        `I can't do ${outOfReach} — that's outside what I'm allowed to touch. ` +
        `It affects other people rather than your data, so it stays a human decision. ` +
        `You can do it yourself in Settings.`,
    };
  }

  if (OUTWARD.has(tool)) {
    return {
      kind: 'approval_gate',
      message: 'This sends something outside the workspace, so it needs your approval first.',
    };
  }

  if (STRUCTURAL_DELETES.has(tool)) {
    const what =
      tool === 'delete_field'
        ? `the field${fieldName ? ` "${fieldName}"` : ''}${databaseName ? ` on ${databaseName}` : ''}`
        : tool === 'delete_database'
          ? `the database${databaseName ? ` "${databaseName}"` : ''}`
          : 'that relation';
    return {
      kind: 'confirm',
      strength: 'strong',
      /*
       * "Gone, not hidden" is the required wording (#358). Someone reading
       * "delete field" can reasonably picture the column being taken off the
       * screen — the rows are still there, after all. Saying what actually
       * happens to the VALUES is the whole point of the stronger tier.
       */
      message:
        `Delete ${what}? Everything stored in it is permanently gone — the records stay, ` +
        `but that information is not hidden, it is deleted, and I can't bring it back.`,
    };
  }

  if (RECORD_DELETES.has(tool)) {
    const n = affected ?? 0;
    return {
      kind: 'confirm',
      strength: 'normal',
      message:
        `Delete ${n === 1 ? '1 record' : `${n} records`}${databaseName ? ` from ${databaseName}` : ''}?`,
    };
  }

  // Checked BEFORE the catch-all, which is the whole point of naming them.
  if (SAFE_DELETES.has(tool)) return { kind: 'proceed' };

  if (DESTRUCTIVE_NAME.test(tool)) {
    return {
      kind: 'confirm',
      strength: 'strong',
      // Names the tool, because an unrecognised destructive action is exactly
      // the case where the user should see precisely what was asked for.
      message: `"${tool}" looks like it removes something, and I don't recognise it. Go ahead?`,
    };
  }

  /**
   * A bulk edit above the threshold confirms too. A silent bulk edit is as
   * destructive as a delete, just quieter — "set every client to Paused" is
   * unrecoverable in practice even though nothing was technically deleted.
   *
   * Shares `BULK_CHECKIN_THRESHOLD` with the runtime so the confirmation cannot
   * predict a different count than the run actually pauses at.
   */
  if (affected !== undefined && affected > BULK_CHECKIN_THRESHOLD) {
    return {
      kind: 'confirm',
      strength: 'normal',
      message:
        `This changes ${affected} records${fieldName ? ` (${fieldName})` : ''}` +
        `${databaseName ? ` in ${databaseName}` : ''}. Go ahead?`,
    };
  }

  // Everything else just happens. This branch is the feature.
  return { kind: 'proceed' };
}
