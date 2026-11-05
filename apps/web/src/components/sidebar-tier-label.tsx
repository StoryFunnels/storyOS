import { cn } from '@/lib/utils';

/**
 * The sidebar's quiet tier label (#805): 10px, wide tracking, caps. ONE definition of the geometry and type, so the AI section and
 * the Settings menu (ticket #1216) cannot drift apart by each restating the classes.
 *
 * The colour is the neutral `--text-muted` (a label is prose, never the fainter glyph colour). A caller that must colour it passes
 * the colour in `className`, which wins: the AI section does, because gold is only allowed in files on the agent allow-list
 * (gold-agents-only.unit.test.ts), and this shared file is not one.
 */
export function SidebarTierLabel({ className, children }: { className?: string; children: React.ReactNode }) {
  return <p className={cn('mb-0.5 mt-1 px-3 text-micro font-semibold uppercase tracking-[0.16em] text-muted', className)}>{children}</p>;
}
