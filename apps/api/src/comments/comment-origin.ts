import type { ChangeSource } from '../db/schema';

/**
 * #1181 — which comments are CONVERSATION: written by a person (`human`, or `mcp` = a person's own tool) or by an agent speaking.
 * Only those may leave StoryOS for an external mirror (the Linear outbox today; any write-back source later). Everything else is
 * StoryOS talking to itself: an approval decision or expiry, a run or delegation notice, an automation's comment, a duplicate's
 * "N comments copied" note, an imported comment. Those are `automation`, and an origin nobody recorded (null) is refused too:
 * an unknown origin must never read as "safe to publish".
 *
 * The rule is POSITIVE on purpose. The old one (`source <> 'automation'`) let anything a writer forgot to mark, including an
 * approver's "Rejected: <reason>", straight out. A writer that wants its comment to stay internal marks it `automation`
 * (`CommentsService.create(..., 'automation')`); a new source value is internal until someone adds it here.
 */
export const EXTERNALLY_PUSHABLE_SOURCES: readonly ChangeSource[] = ['human', 'agent', 'mcp'];

export const isPushableCommentSource = (source: ChangeSource | null | undefined): boolean =>
  source != null && EXTERNALLY_PUSHABLE_SOURCES.includes(source);
