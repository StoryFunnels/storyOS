'use client';

import { Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * The avatar for a named agent (#364).
 *
 * **Why this exists at all:** Tyron Dizon is a real member of this workspace
 * (tyron.dizon@storypages.ai), and the assistant is also called Tyron. Without a
 * visual difference, "Tyron" beside a message is genuinely ambiguous.
 *
 * **Defined GENERICALLY, not special-cased for Tyron.** #364's own framing is
 * "every agent is named", and packs already ship agents (a Triage agent, for
 * one). If this were a Tyron-shaped component, the second and third agent would
 * each invent their own treatment — which is the divergence #380 and #383 both
 * document, arriving for a third time.
 *
 * **A mark, never a person.** The rule is that an agent avatar must not be
 * mistakable for a member's photo or initials circle at a glance:
 *
 * - a SQUIRCLE, not a circle — every member avatar in the app is round, so the
 *   silhouette differs before any colour or glyph is read;
 * - an accent-tinted surface rather than the generated per-person colours;
 * - a glyph, never initials. A circle with a "T" is exactly the collision this
 *   ticket exists to prevent.
 *
 * #364 was narrowed by #357's attribution decision: record history, comments and
 * notifications all name the PERSON who asked, so this is only ever the chat
 * surface. It is not an actor identity and must not grow into one.
 */
export function AgentAvatar({
  name,
  size = 'md',
  className,
}: {
  /** The agent's name — used for the accessible label, never rendered as initials. */
  name: string;
  size?: 'sm' | 'md';
  className?: string;
}) {
  const px = size === 'sm' ? 'h-5 w-5' : 'h-7 w-7';
  const glyph = size === 'sm' ? 'h-3 w-3' : 'h-4 w-4';
  return (
    <span
      // "agent" is in the label because a screen reader gets none of the visual
      // distinction above — without it, the ambiguity this component fixes is
      // simply reintroduced for anyone not looking at the screen.
      aria-label={`${name} (agent)`}
      title={`${name} — an agent, not a person`}
      className={cn(
        'inline-flex shrink-0 items-center justify-center',
        // rounded-md, not rounded-full: the shape IS the signal.
        'rounded-md border border-[var(--accent)]/30 bg-accent-soft text-[var(--accent)]',
        px,
        className,
      )}
    >
      <Sparkles className={glyph} aria-hidden />
    </span>
  );
}

/**
 * The badge that follows an agent's NAME wherever it is written out (#364).
 *
 * Separate from the avatar because the two appear in different places: a reply
 * shows the avatar, while a line of prose naming the agent needs the word. Both
 * are needed for the same reason and drift if only one exists.
 */
export function AgentBadge({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'rounded border border-border-default px-1 py-px text-[10px] font-medium uppercase tracking-wide text-muted',
        className,
      )}
    >
      Agent
    </span>
  );
}
