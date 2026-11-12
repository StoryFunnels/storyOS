import { Bot, HelpCircle, Terminal, Workflow } from 'lucide-react';
import { cn } from '@/lib/utils';
import { isAiSource } from '@/lib/governance';

/** The source of a write as the API records it. `null` is "not recorded": never folded into a person. */
export type BadgeSource = 'human' | 'agent' | 'automation' | 'mcp' | null;

/** The badge's tooltip: with the agent's name when it is known, so the gold says WHO the agent is, not only that one was there. */
export function sourceBadgeTitle(source: 'agent' | 'automation' | 'mcp', agentName?: string | null): string {
  const name = typeof agentName === 'string' ? agentName.trim() : '';
  if (source === 'agent' && name) return `Made by ${name}, an agent, not typed by a person`;
  return `This event was made by ${source === 'mcp' ? 'an MCP client' : `an ${source}`}, not typed by a person`;
}

/**
 * #496 — a badge distinguishing WHAT made a write, next to the actor name.
 * 'human' renders nothing: it is the default the reader already assumes, and
 * marking every ordinary edit would bury the exceptions it exists to surface.
 * null is NOT folded into that same "no badge" treatment — it gets its own
 * faint, explicitly-labelled badge, so a row with genuinely missing source
 * data reads as "not recorded", not as an unmarked human edit.
 */
export function SourceBadge({ source, agentName }: { source: BadgeSource; agentName?: string | null }) {
  if (source === 'human') return null;
  if (source === null) {
    return (
      <span
        title="Source not recorded for this event"
        className="inline-flex items-center gap-1 rounded-full border border-border-default px-1.5 py-0.5 text-micro text-faint"
      >
        <HelpCircle className="h-3 w-3" />
        unknown source
      </span>
    );
  }
  const config: Record<'agent' | 'automation' | 'mcp', { icon: typeof Bot; label: string }> = {
    agent: { icon: Bot, label: 'agent' },
    automation: { icon: Workflow, label: 'automation' },
    mcp: { icon: Terminal, label: 'MCP' },
  };
  const { icon: Icon, label } = config[source];
  return (
    <span
      title={sourceBadgeTitle(source, agentName)}
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-micro font-medium',
        // Gold marks an AI acting (agent, MCP): the one shared rule `isAiSource`. An automation is a rule a person configured, so it stays neutral.
        isAiSource(source) ? 'bg-accent-soft text-accent-text' : 'bg-hover text-primary-text',
      )}
    >
      <Icon className="h-3 w-3" />
      {label}
    </span>
  );
}
