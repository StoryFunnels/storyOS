'use client';

import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import type { SkillTemplate } from '@storyos/schemas';
import { cn } from '@/lib/utils';
import { useSkillTemplates } from './use-skills';

/**
 * The scaffolds that ship with StoryOS, as cards — real templates from `GET /skills/templates`, never an illustration.
 * One component for BOTH doors to them (the library's empty state and the New skill chooser, #997), so the two cannot
 * drift: a card is a link to `skills/new?template=<id>`, and "Blank" is the dashed one.
 */
export function SkillTemplateCards({ ws, templates, className }: { ws: string; templates: SkillTemplate[]; className?: string }) {
  return (
    <div className={cn('grid grid-cols-[repeat(auto-fit,minmax(min(100%,16rem),1fr))] gap-2', className)}>
      {templates.map((t) => (
        <Link
          key={t.id}
          href={`/w/${ws}/skills/new?template=${encodeURIComponent(t.id)}`}
          className={cn(
            'rounded-[var(--radius-card)] border px-3 py-2.5 hover:bg-hover',
            t.id === 'blank' ? 'border-dashed border-border-strong' : 'border-border-default bg-card',
          )}
        >
          <span className="block text-body font-semibold text-ink">{t.name}</span>
          <span className="mt-0.5 block text-label leading-normal text-muted">{t.description}</span>
        </Link>
      ))}
    </div>
  );
}

/**
 * "New skill" before a scaffold is chosen (the prototype's `skillNew`): a back arrow, the title, and the same cards
 * the empty library shows. Picking one opens the editor on it; "Blank" opens it empty.
 */
export function NewSkillChooser({ ws }: { ws: string }) {
  const templates = useSkillTemplates(ws);
  return (
    <div className="w-full max-w-[1080px] px-7 pb-[60px] pt-[22px]">
      <div className="flex items-center gap-2 border-b border-border-default px-5 py-3">
        <Link
          href={`/w/${ws}/skills`}
          aria-label="Back to Skills"
          className="rounded p-1 text-muted hover:bg-hover hover:text-ink"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <h1 className="text-title font-bold tracking-tight text-ink">New skill</h1>
        <span className="text-label text-muted">new</span>
      </div>
      <p className="mx-5 my-3 text-body text-muted">Start from one that ships with StoryOS, or from a blank page.</p>
      {templates.isPending && <p className="px-5 py-3 text-body text-muted">Loading scaffolds…</p>}
      {templates.isError && (
        <p className="px-5 py-3 text-body text-error" role="alert">
          Could not load the scaffolds. You can still{' '}
          <Link href={`/w/${ws}/skills/new?template=blank`} className="underline">
            start from a blank page
          </Link>
          .
        </p>
      )}
      {templates.isSuccess && <SkillTemplateCards ws={ws} templates={templates.data} className="mx-5 mt-3.5" />}
    </div>
  );
}
