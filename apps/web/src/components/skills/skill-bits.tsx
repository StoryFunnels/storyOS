'use client';

import { Bot, Building2, Lock } from 'lucide-react';
import type { SkillSummary } from '@storyos/schemas';
import { cn } from '@/lib/utils';
import { VISIBILITY_CHIP } from './skill-meta';
import type { Segment } from './skill-compare';

/** The visibility chip. Two values today (ticket #841 carries the other two). */
export function VisibilityChip({ visibility }: { visibility: SkillSummary['visibility'] }) {
  const Icon = visibility === 'personal' ? Lock : Building2;
  return (
    <span className="inline-flex h-5 items-center gap-1 rounded-[var(--radius-chip)] bg-hover px-1.5 text-label font-medium text-ink-secondary">
      <Icon className="h-3 w-3" />
      {VISIBILITY_CHIP[visibility]}
    </span>
  );
}

/**
 * A skill written by an agent or over MCP rather than typed by a person (#442,
 * derived from the request's auth, so it cannot be claimed by its author; #831
 * is the gold mark). A person-authored skill carries no mark — it is the
 * default the reader assumes, and marking every row would bury the exception.
 */
export function SkillSourceMark({ source }: { source: SkillSummary['source'] }) {
  if (source === 'human') return null;
  return (
    <span
      title="Written by an agent or an MCP client, not typed by a person"
      className="inline-flex h-[17px] items-center gap-1 rounded-full bg-accent-soft px-1.5 text-micro font-bold text-accent"
    >
      <Bot className="h-2.5 w-2.5" />
      {source === 'mcp' ? 'MCP-written' : 'Agent-written'}
    </span>
  );
}

/** Render marked runs: red = wording shared with a rival, green = what only
 * this skill says. Colour is NEVER the only signal — shared runs are underlined
 * and unique runs are bold, so it reads in grayscale and for colour-blind users. */
export function MarkedText({ segments }: { segments: Segment[] }) {
  return (
    <>
      {segments.map((s, i) =>
        s.kind === 'plain' ? (
          <span key={i}>{s.text}</span>
        ) : (
          <span
            key={i}
            className={cn(
              'rounded-sm px-0.5',
              s.kind === 'shared'
                ? 'bg-error/15 text-error underline decoration-dotted underline-offset-2'
                : 'bg-success/15 font-semibold text-success',
            )}
            title={s.kind === 'shared' ? 'Wording shared with a rival skill' : 'Only this skill says this'}
          >
            {s.text}
          </span>
        ),
      )}
    </>
  );
}
