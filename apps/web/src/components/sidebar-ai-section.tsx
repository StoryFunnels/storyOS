'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Activity, Bot, ChevronRight, Library, Package, Plug } from 'lucide-react';
import { GlyphSlot, SidebarRow } from '@/components/sidebar-row';
import { CARET_HIT_AREA } from '@/components/sidebar-row-style';
import {
  CONNECT_AI_MOVED_HINT,
  CONNECT_AI_MOVED_TOAST,
  goldCountLabel,
  shouldAnnounceMove,
  showConnectAiRow,
  useAiConnected,
  APPROVALS_LIST_LIMIT,
  usePackUpdateCount,
  usePendingApprovalCount,
} from '@/lib/sidebar-ai';
import { useDismissedHints } from '@/lib/dismissed-hints';
import { useDatabases } from '@/lib/queries';
import { AGENT_SYSTEM_LABELS, agentSystemDatabases } from '@/lib/system-databases';
import { cn } from '@/lib/utils';

/**
 * #967 — the AI layer's own home, in gold (#831: gold means agency). "Collections" is gone.
 *
 * Gold marks, ink speaks: the label and glyphs are gold, the row text stays ink, so the section
 * is findable without shouting. The gold is `--accent-text`, not `--accent`: `--accent` measures
 * 2.07:1 on the sidebar in light mode, below both the 4.5:1 text bar and the 3:1 bar for a glyph
 * (#706), so the same hue is used one step darker where it carries text or a glyph.
 *
 * #1058 — Skills · Agents ▸ (Agent runs, Triggers) · Automation runs · Connect your AI (until connected) · Business Packs.
 * The three Agentic OS system databases are reached from HERE and no longer sit in the Spaces list; "Agents" opens the Agents
 * database and its two children each keep their own URL. A child (or the group) is absent until its database exists.
 *
 * Rows: Skills · Automation runs (gold count = actions waiting for approval) · Business Packs (gold
 * count = installed packs with an update). "Connect your AI" is NOT here yet: whether the
 * workspace has a connected AI client needs an endpoint (open for Marek on #967), and the row's
 * badge must not be guessed.
 */
export function SidebarAiSection({ ws, canConnectAi = true }: { ws: string; canConnectAi?: boolean }) {
  const pathname = usePathname();
  const approvals = usePendingApprovalCount(ws);
  const packUpdates = usePackUpdateCount(ws);
  // #967 — "Connect your AI": a 1 (neutral, #1163) until the workspace has a connected AI, then it is gone.
  // A guest cannot open the page (settings-nav `canConnectAi`), so a guest is never nudged toward it.
  const aiConnected = useAiConnected(ws);
  const hints = useDismissedHints(ws);
  const previous = useRef<boolean | undefined>(undefined);
  useEffect(() => {
    const now = aiConnected.data;
    const shown = hints.dismissed === undefined ? undefined : hints.dismissed.includes(CONNECT_AI_MOVED_HINT);
    if (canConnectAi && shouldAnnounceMove(previous.current, now, shown)) {
      toast(CONNECT_AI_MOVED_TOAST);
      hints.setDismissed(CONNECT_AI_MOVED_HINT, true);
    }
    if (now !== undefined) previous.current = now;
  }, [aiConnected.data, hints.dismissed, canConnectAi]);

  const databases = useDatabases(ws);
  const agentDbs = agentSystemDatabases(databases.data ?? []);
  const [agentsOpen, setAgentsOpen] = useState(false);
  const dbHref = (id: string) => `/w/${ws}/d/${id}`;
  const agentChildren = [
    { key: 'runs' as const, db: agentDbs.runs },
    { key: 'agent triggers' as const, db: agentDbs['agent triggers'] },
  ].flatMap((c) => (c.db ? [{ label: AGENT_SYSTEM_LABELS[c.key], href: dbHref(c.db.id) }] : []));
  const agentsHref = agentDbs.agents ? dbHref(agentDbs.agents.id) : null;
  const onAgents = (href: string | null) => href !== null && (pathname === href || !!pathname?.startsWith(`${href}/`));
  // Open on arrival at one of the group's pages, so the active row is never hidden inside a closed group.
  const inGroup = onAgents(agentsHref) || agentChildren.some((c) => onAgents(c.href));
  useEffect(() => {
    if (inGroup) setAgentsOpen(true);
  }, [inGroup]);

  const rows = [
    {
      href: `/w/${ws}/skills`,
      label: 'Skills',
      Icon: Library,
      active: pathname === `/w/${ws}/skills` || !!pathname?.startsWith(`/w/${ws}/skills/`),
      count: null as string | null,
      countHint: undefined as string | undefined,
    },
    {
      href: `/w/${ws}/runs`,
      label: 'Automation runs',
      Icon: Activity,
      active: pathname === `/w/${ws}/runs` || !!pathname?.startsWith(`/w/${ws}/runs/`),
      count: goldCountLabel(approvals.data ?? 0, APPROVALS_LIST_LIMIT),
      countHint: 'Agent actions waiting for your approval',
    },
    ...(canConnectAi && showConnectAiRow(aiConnected.data)
      ? [
          {
            href: `/w/${ws}/settings/connect-ai`,
            label: 'Connect your AI',
            Icon: Plug,
            active: pathname === `/w/${ws}/settings/connect-ai`,
            count: '1' as string | null,
            countHint: 'Your workspace has no connected AI yet' as string | undefined,
            agentBadge: false,
          },
        ]
      : []),
    {
      href: `/w/${ws}/packs`,
      label: 'Business Packs',
      Icon: Package,
      active: pathname === `/w/${ws}/packs` || !!pathname?.startsWith(`/w/${ws}/packs/`),
      count: goldCountLabel(packUpdates.data ?? 0),
      countHint: 'Installed packs with an update available',
      agentBadge: false,
    },
  ].map((r) => ({ agentBadge: true, ...r }));

  const renderRow = ({ href, label, Icon, active, count, countHint, agentBadge }: (typeof rows)[number]) => (
    <SidebarRow key={href} depth={0} active={active}>
      <Link
        href={href}
        aria-current={active ? 'page' : undefined}
        className="flex min-w-0 flex-1 items-center gap-2 text-body"
      >
        <GlyphSlot>
          <Icon className="h-3.5 w-3.5 text-accent-text" />
        </GlyphSlot>
        <span className="min-w-0 flex-1 overflow-hidden whitespace-nowrap">{label}</span>
        {count && (
          <span
            title={countHint}
            aria-label={countHint ? `${count}: ${countHint}` : count}
            className={cn(
              'flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full px-1 text-micro font-bold tabular-nums',
              // #1163 — gold counts AGENT work waiting on you; a setup nudge or an update count is not that.
              agentBadge ? 'bg-accent text-on-accent' : 'bg-primary text-[var(--text-on-dark)]',
            )}
          >
            {count}
          </span>
        )}
      </Link>
    </SidebarRow>
  );

  return (
    <div data-testid="sidebar-ai-section">
      {/* #805 — the quiet tier label (10px, wide tracking); gold, and a notch heavier so it reads as a mark. */}
      <p className="mb-0.5 mt-1 px-3 text-micro font-semibold uppercase tracking-[0.16em] text-accent-text">AI</p>
      {rows.slice(0, 1).map(renderRow)}
      {agentsHref && (
        <>
          <SidebarRow
            depth={0}
            active={onAgents(agentsHref)}
            caret={
              agentChildren.length > 0 ? (
                <button
                  type="button"
                  aria-label={agentsOpen ? 'Collapse Agents' : 'Expand Agents'}
                  aria-expanded={agentsOpen}
                  onClick={() => setAgentsOpen((v) => !v)}
                  className={cn('rounded text-faint hover:text-ink', CARET_HIT_AREA)}
                >
                  <ChevronRight className={cn('h-3 w-3 transition-transform', agentsOpen && 'rotate-90')} />
                </button>
              ) : undefined
            }
          >
            <Link
              href={agentsHref}
              aria-current={onAgents(agentsHref) ? 'page' : undefined}
              className="flex min-w-0 flex-1 items-center gap-2 text-body"
            >
              <GlyphSlot>
                <Bot className="h-3.5 w-3.5 text-accent-text" />
              </GlyphSlot>
              <span className="min-w-0 flex-1 overflow-hidden whitespace-nowrap">{AGENT_SYSTEM_LABELS.agents}</span>
            </Link>
          </SidebarRow>
          {agentsOpen &&
            agentChildren.map((c) => (
              <SidebarRow key={c.href} depth={1} lens active={onAgents(c.href)}>
                <Link
                  href={c.href}
                  aria-current={onAgents(c.href) ? 'page' : undefined}
                  className="flex min-w-0 flex-1 items-center gap-2 text-body"
                >
                  <span className="min-w-0 flex-1 overflow-hidden whitespace-nowrap">{c.label}</span>
                </Link>
              </SidebarRow>
            ))}
        </>
      )}
      {rows.slice(1).map(renderRow)}
    </div>
  );
}
