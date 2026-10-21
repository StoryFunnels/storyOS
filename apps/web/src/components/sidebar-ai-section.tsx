'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { Activity, Library, Package, Plug } from 'lucide-react';
import { GlyphSlot, SidebarRow } from '@/components/sidebar-row';
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

/**
 * #967 — the AI layer's own home, in gold (#831: gold means agency). "Collections" is gone.
 *
 * Gold marks, ink speaks: the label and glyphs are gold, the row text stays ink, so the section
 * is findable without shouting. The gold is `--accent-text`, not `--accent`: `--accent` measures
 * 2.07:1 on the sidebar in light mode, below both the 4.5:1 text bar and the 3:1 bar for a glyph
 * (#706), so the same hue is used one step darker where it carries text or a glyph.
 *
 * Rows: Skills · Agent runs (gold count = actions waiting for approval) · Business Packs (gold
 * count = installed packs with an update). "Connect your AI" is NOT here yet: whether the
 * workspace has a connected AI client needs an endpoint (open for Marek on #967), and the row's
 * badge must not be guessed.
 */
export function SidebarAiSection({ ws, canConnectAi = true }: { ws: string; canConnectAi?: boolean }) {
  const pathname = usePathname();
  const approvals = usePendingApprovalCount(ws);
  const packUpdates = usePackUpdateCount(ws);
  // #967 — "Connect your AI": a gold 1 and a tint until the workspace has a connected AI, then it is gone.
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
      label: 'Agent runs',
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
            tint: true,
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
    },
  ].map((r) => ({ tint: false, ...r }));

  return (
    <div data-testid="sidebar-ai-section">
      {/* #805 — the quiet tier label (10px, wide tracking); gold, and a notch heavier so it reads as a mark. */}
      <p className="mb-0.5 mt-1 px-3 text-micro font-semibold uppercase tracking-[0.16em] text-accent-text">AI</p>
      {rows.map(({ href, label, Icon, active, count, countHint, tint }) => (
        <SidebarRow key={href} depth={0} active={active} className={tint ? 'bg-accent-soft' : undefined}>
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
                className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-accent px-1 text-micro font-bold tabular-nums text-on-accent"
              >
                {count}
              </span>
            )}
          </Link>
        </SidebarRow>
      ))}
    </div>
  );
}
