'use client';

import { Bot, Database, Workflow } from 'lucide-react';

/**
 * #77's pack preview, extracted for #351.
 *
 * #77 solved "help users find the right pack" for the in-app gallery — card
 * density, visual previews instead of prose — and its own notes flagged that the
 * NEW-WORKSPACE picker had the same problem and was "worth solving once,
 * consistently, in both places". It was not, so the first screen every signup
 * sees kept describing databases in a paragraph nobody can picture.
 *
 * Shared rather than copied, so the two galleries cannot drift the way the
 * sidebar row types did (#380).
 */
export interface PackPreviewCounts {
  slug: string;
  name: string;
  preview: { databases: number; views: number; automations: number; agents: number };
}

export function registryVertical(slug: string): string {
  if (slug === 'agency-os' || slug === 'client-portal' || slug === 'consulting-os') return 'agency';
  if (slug === 'content-engine') return 'marketing';
  if (slug === 'dev-project-os') return 'engineering';
  if (slug === 'support-inbox') return 'support';
  if (slug === 'coaching-os') return 'ops';
  return 'other';
}

/** "1 databases" shipped on the first screen every signup sees. */
function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function PackVisual({ pack }: { pack: PackPreviewCounts }) {
  const vertical = registryVertical(pack.slug);
  const accent =
    vertical === 'agency'
      ? 'from-amber-100 to-orange-50'
      : vertical === 'marketing'
        ? 'from-pink-100 to-violet-50'
        : vertical === 'engineering'
          ? 'from-blue-100 to-cyan-50'
          : vertical === 'support'
            ? 'from-emerald-100 to-teal-50'
            : 'from-stone-100 to-slate-50';
  return (
    <div
      /**
       * #351 — the panels were literal `bg-white/*` while the text used the
       * `text-ink` TOKEN, which is light in dark mode. Light text on white panels
       * meant the counts were invisible in dark — always true in the gallery, and
       * now on the first screen every signup sees.
       *
       * Panels use `bg-card` so they follow the theme; the coloured gradient is
       * applied through a low-opacity overlay so it tints both themes instead of
       * washing one out.
       */
      /* `shrink-0`: this sits in a flex COLUMN card. Without it the preview is
         the flex item that gives way when a long summary needs room — it was
         squeezed 112px -> 43px before the summary's clamp was repaired. The
         preview is the point of the card; it must never be the thing that
         yields. */
      className="relative h-28 shrink-0 overflow-hidden rounded-[var(--radius-control)] border border-border-default bg-card p-3"
      
      aria-label={`${pack.name} contains ${plural(pack.preview.databases, 'database')}, ${plural(pack.preview.views, 'view')}, ${plural(pack.preview.automations, 'automation')}, and ${plural(pack.preview.agents, 'agent')}`}
    >
      <div className={`pointer-events-none absolute inset-0 bg-gradient-to-br opacity-40 dark:opacity-20 ${accent}`} />
      <div className="absolute -right-5 -top-6 h-20 w-20 rounded-full border border-border-default/60 bg-card/40" />
      <div className="relative grid h-full grid-cols-2 gap-2">
        <div className="rounded border border-border-default bg-card/90 p-2 shadow-sm">
          <Database className="h-3.5 w-3.5 text-ink" />
          <p className="mt-2 text-[16px] font-semibold text-ink">{pack.preview.databases}</p>
          <p className="text-[10px] text-muted">{pack.preview.databases === 1 ? 'database' : 'databases'}</p>
        </div>
        <div className="flex flex-col gap-2">
          <div className="flex flex-1 items-center gap-2 rounded border border-border-default bg-card/90 px-2 shadow-sm">
            <Workflow className="h-3.5 w-3.5 text-ink" />
            <span className="text-[10px] text-muted">{plural(pack.preview.automations, 'automation')}</span>
          </div>
          <div className="flex flex-1 items-center gap-2 rounded border border-border-default bg-card/90 px-2 shadow-sm">
            <Bot className="h-3.5 w-3.5 text-ink" />
            <span className="text-[10px] text-muted">{plural(pack.preview.agents, 'agent')}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
