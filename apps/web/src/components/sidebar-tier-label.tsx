import { cn } from '@/lib/utils';

/**
 * The sidebar's quiet tier label (#805): 9px mono, wide tracking, caps. ONE definition of the geometry and type, so the AI
 * section, the Spaces header, Favorites and the Settings menu (ticket #1216) cannot drift apart by each restating the classes.
 * Ticket #1273 item 3: the build had two different tier styles stacked on each other (AI 10px/1.6px, Spaces 11px/0.55px, a
 * hand-rolled span); the prototype uses one: mono, 9px, 0.16em (1.44px) tracking. Every tier label goes through this component.
 *
 * Font: `font-mono` is the platform monospace stack. The prototype names IBM Plex Mono, which this build does not self-host
 * (#797: fonts are self-hosted, no third-party fetch), so the face falls back; size, tracking and case match.
 *
 * Weight is the caller's call: the default is regular, and the one tier that is a mark (the gold AI label) passes `font-semibold`.
 *
 * The colour is the neutral `--text-muted` (a label is prose, never the fainter glyph colour). A caller that must colour it passes
 * the colour in `className`, which wins: the AI section does, because gold is only allowed in files on the agent allow-list
 * (gold-agents-only.unit.test.ts), and this shared file is not one.
 */
export function SidebarTierLabel({ className, children }: { className?: string; children: React.ReactNode }) {
  return <p className={cn('mb-0.5 mt-1 px-3 font-mono text-[9px] font-normal uppercase leading-[11px] tracking-[0.16em] text-muted', className)}>{children}</p>;
}
