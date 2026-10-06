'use client';

import { Bell, Bot } from 'lucide-react';
import type { CSSProperties } from 'react';
import { OPTION_COLORS } from '@/components/table-view/option-colors';
import { cn } from '@/lib/utils';
import { heroChips, packHueName, workflowSentence } from './pack-workflow-display';

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
  /** #824 — read from the pack's own manifest by the registry endpoint. */
  workflow?: { database: string; field: string; stages: string[][] } | null;
  marks?: { agent: boolean; notifies: boolean };
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
export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** The one-line inventory — gallery-only chrome (see PackVisual's doc). */
export function packCountsLine(p: PackPreviewCounts['preview']): string {
  return [plural(p.databases, 'database'), plural(p.views, 'view'), plural(p.automations, 'automation'), plural(p.agents, 'agent')].join(' · ');
}

/**
 * #824 — the 112px hero is the pack's WORKFLOW, drawn as a pipeline of state chips.
 *
 * It replaces a counts panel whose automations and agents were "1" on all eight
 * packs: the element the code called "the point of the card" could not tell two
 * packs apart. The workflow differs on every pack by construction, and it is what
 * you are buying — a way of working, not an inventory. The counts survive as one
 * line in the gallery (`packCountsLine`), where they belong at install time.
 *
 * ── Two surfaces share this, so the contract is narrow ───────────────────────
 * ONLY the hero's contents are shared. The new-workspace picker's card is a fixed
 * `h-[196px] overflow-hidden p-2` (#351/#376): 196 - 16 padding - 8 gap - 112 hero
 * leaves 60px for a title and a two-line summary and NOTHING else. So the
 * Installed badge, the counts line and the CTA buttons are gallery-card chrome and
 * live in packs/page.tsx — carried here they would be clipped without an error, on
 * the first screen every signup sees. THE HERO STAYS EXACTLY 112px (`h-28`): that
 * number is load-bearing on the other surface.
 *
 * Colour: the pack's hue is a key of OPTION_COLORS, and chips use the shared
 * `option-tint` ink (#638) — the same audited light/dark contrast as every other
 * chip — so there is no second colour mechanism to drift. The tint and border are
 * mixed over `bg-card`, which follows the theme; nothing here is a literal white
 * (that was #351's light-on-white-in-dark bug).
 */
export function PackVisual({ pack }: { pack: PackPreviewCounts }) {
  const hue = OPTION_COLORS[packHueName(pack.slug)]!;
  const chips = pack.workflow ? heroChips(pack.workflow.stages) : [];
  const spoken = pack.workflow ? `${pack.name} workflow: ${workflowSentence(pack.workflow.stages)}. ` : `${pack.name}. `;
  return (
    <div
      /* `shrink-0`: this sits in a flex COLUMN card. Without it the hero is the flex
         item that gives way when a long summary needs room — it was squeezed
         112px -> 43px before the summary's clamp was repaired. */
      className="relative flex h-28 shrink-0 flex-col gap-1.5 overflow-hidden rounded-[var(--radius-control)] border px-3 py-2.5"
      style={
        {
          '--pack-hue': hue,
          '--option-color': hue,
          borderColor: 'color-mix(in srgb, var(--pack-hue) 26%, var(--border-default))',
          background: 'linear-gradient(160deg, color-mix(in srgb, var(--pack-hue) 9%, var(--bg-card)), var(--bg-card) 72%)',
        } as CSSProperties
      }
      aria-label={`${spoken}Contains ${packCountsLine(pack.preview)}.`}
    >
      {pack.workflow && (
        <p className="option-tint truncate text-micro font-semibold uppercase tracking-wider opacity-80">
          {pack.workflow.database} · {pack.workflow.field}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-y-1" aria-hidden>
        {chips.map((chip, i) => (
          <span key={i} className="flex items-center">
            {chip.kind === 'more' ? (
              <span className="option-tint inline-flex h-5 items-center rounded-full border border-dashed border-[color-mix(in_srgb,var(--pack-hue)_40%,transparent)] px-1.5 text-micro font-bold tracking-wide">
                +{chip.hidden}
              </span>
            ) : (
              <span
                className={cn(
                  'option-tint inline-flex h-5 items-center whitespace-nowrap rounded-full border border-[color-mix(in_srgb,var(--pack-hue)_24%,transparent)] px-1.5 text-micro font-semibold',
                )}
                style={{ backgroundColor: `color-mix(in srgb, var(--pack-hue) ${chip.end ? 30 : 14}%, var(--bg-card))` }}
              >
                {chip.label}
                {chip.alt > 0 && <span className="ml-1 text-micro font-bold opacity-70">/ +{chip.alt}</span>}
              </span>
            )}
            {i < chips.length - 1 && (
              <span className="relative mx-px h-px w-2 shrink-0 bg-[color-mix(in_srgb,var(--pack-hue)_35%,transparent)]" />
            )}
          </span>
        ))}
      </div>
      {(pack.marks?.agent || pack.marks?.notifies) && (
        <div className="mt-auto flex items-center gap-1.5" aria-hidden>
          {pack.marks.agent && (
            <span className="inline-flex h-4 items-center gap-1 rounded-[var(--radius-chip)] bg-hover px-1.5 text-micro font-semibold text-muted">
              <Bot className="h-2.5 w-2.5" />
              Agent
            </span>
          )}
          {pack.marks.notifies && (
            <span className="inline-flex h-4 items-center gap-1 rounded-[var(--radius-chip)] bg-hover px-1.5 text-micro font-semibold text-muted">
              <Bell className="h-2.5 w-2.5" />
              Notifies
            </span>
          )}
        </div>
      )}
    </div>
  );
}
