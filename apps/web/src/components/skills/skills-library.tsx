'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import { Plus } from 'lucide-react';
import type { SkillSummary, SkillTemplate } from '@storyos/schemas';
import { cn } from '@/lib/utils';
import { useMembers } from '@/components/table-view/use-table-data';
import { SkillSourceMark, VisibilityChip } from './skill-bits';
import { initials, runLine } from './skill-meta';
import { useSkillTemplates, useSkills } from './use-skills';

/**
 * #833 — the Skills library: a place to read and write a way of working, for TWO
 * readers at once (a person authoring and governing it, and a model deciding
 * whether to use it).
 *
 * Rows, not cards, with `when_to_use` on EVERY row rather than behind a click:
 * a library that makes you open things to learn what they are quietly pushes
 * people toward fewer, bigger skills, and the research says one job per skill
 * (design ticket #836; Otto's ruling on #833).
 */
export function SkillsLibrary({ ws }: { ws: string }) {
  const skills = useSkills(ws);
  const templates = useSkillTemplates(ws);
  const members = useMembers(ws, true);
  const names = useMemo(() => new Map((members.data ?? []).map((m) => [m.user.id, m.user.name])), [members.data]);
  const now = Date.now();
  const list = skills.data ?? [];

  return (
    <div className="mx-auto flex h-full w-full max-w-4xl flex-col">
      <div className="flex items-center gap-2 border-b border-border-default px-4 py-3">
        <h1 className="text-title font-bold tracking-tight text-ink">Skills</h1>
        {skills.isSuccess && (
          <span className="text-label text-muted">{list.length === 0 ? 'no skills yet' : `${list.length} skill${list.length === 1 ? '' : 's'}`}</span>
        )}
        <span className="flex-1" />
        <Link
          href={`/w/${ws}/skills/new`}
          className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-control)] bg-primary px-3 text-body font-medium text-[var(--text-on-dark)] hover:bg-primary-hover"
        >
          <Plus className="h-3.5 w-3.5" /> New skill
        </Link>
      </div>

      {skills.isPending && <p className="px-4 py-6 text-body text-muted">Loading skills…</p>}
      {skills.isError && (
        <p className="px-4 py-6 text-body text-error" role="alert">
          Could not load skills. Try again in a moment.
        </p>
      )}
      {skills.isSuccess && list.length === 0 && <EmptyState ws={ws} templates={templates.data ?? []} />}
      {skills.isSuccess && list.length > 0 && (
        <ul className="flex flex-col">
          {list.map((skill) => (
            <SkillRow key={skill.id} ws={ws} skill={skill} authorName={names.get(skill.owner_id)} membersLoaded={members.isSuccess} now={now} />
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * AC6 (ticket #833) — THERE IS NO "RUN" BUTTON HERE, AND THAT IS THE POSITION,
 * NOT A GAP. Do not add one.
 *
 * The product thesis is "I don't want my AI inside your product, I want YOUR
 * PRODUCT in MY AI": StoryOS stores a skill, versions it and decides who can see
 * it; the model that carries it out is always the READER'S OWN, run from their
 * AI client over MCP (`list_skills` to find it, `run_skill` to resolve it).
 * StoryOS executes nothing and meters nothing for skills.
 *
 * `POST /skills/:id/run` exists, mirroring AgentsController, so a button looks
 * like the obvious missing piece. It is not: with no managed runtime it would
 * resolve the instructions, record a run, and hand the user text — pressing it
 * would do nothing useful. And building it is the first step toward putting OUR
 * AI inside OUR product, the thing we decided against.
 *
 * The line under each row ("ran 2d ago · ok") IS shown, because StoryOS does
 * record runs and the library must not imply nothing ever ran. Showing the last
 * result is a currency signal; a button is an affordance. Keep the first, never
 * the second. (Contrast: AI FIELDS do have a managed runtime — a different
 * posture, to be decided deliberately one day, and not here.)
 * `skills-library.unit.test.ts` fails if this surface calls the run endpoint.
 * ─────────────────────────────────────────────────────────────────────────────
 */
function SkillRow({
  ws,
  skill,
  authorName,
  membersLoaded,
  now,
}: {
  ws: string;
  skill: SkillSummary;
  authorName: string | undefined;
  membersLoaded: boolean;
  now: number;
}) {
  const run = runLine(skill, now);
  // The author stays on the record; if they are no longer a member, accountability
  // falls to workspace admins by rule (design #836) — the row says so rather than
  // inventing a successor. Only claimed once the member list has actually loaded.
  const authorGone = membersLoaded && !authorName;
  return (
    <li className="border-b border-border-default last:border-b-0">
      <Link
        href={`/w/${ws}/skills/${skill.id}`}
        className="grid grid-cols-[1fr_9.5rem_7.5rem] items-start gap-3.5 px-4 py-3 hover:bg-hover"
      >
        <span className="min-w-0">
          <span className="flex flex-wrap items-center gap-1.5 text-prose font-semibold tracking-tight text-ink">
            {skill.name}
            <SkillSourceMark source={skill.source} />
          </span>
          <span className="mt-0.5 line-clamp-2 text-body leading-normal text-muted">{skill.when_to_use}</span>
        </span>
        <span className="flex min-w-0 flex-col gap-0.5 text-label text-muted">
          <span className="flex items-center gap-1.5 text-ink-secondary">
            <span
              aria-hidden
              className="flex h-[17px] w-[17px] shrink-0 items-center justify-center rounded-full bg-primary text-[8px] font-bold text-[var(--text-on-dark)]"
            >
              {authorGone ? 'A' : initials(authorName)}
            </span>
            <span className="truncate">{authorGone ? 'admins (author left)' : (authorName ?? '…')}</span>
          </span>
          <span className={cn(run.failed && 'font-semibold text-error')}>{run.text}</span>
        </span>
        <span className="flex flex-col items-start gap-1">
          <VisibilityChip visibility={skill.visibility} />
        </span>
      </Link>
    </li>
  );
}

/**
 * The empty state is the FRONT DOOR, not a corner case: `list_skills` returns
 * `[]` in every new workspace. It offers the scaffolds that ship with the
 * product — real ones, not an illustration and a button.
 */
function EmptyState({ ws, templates }: { ws: string; templates: SkillTemplate[] }) {
  return (
    <div className="px-4 py-6">
      <h2 className="text-title font-bold tracking-tight text-ink">Nothing here yet — and that is the normal start.</h2>
      <p className="mt-1 max-w-[60ch] text-body leading-normal text-muted">
        A skill is a way of working you write once: what it does, and the sentence that tells any AI when to reach for it.
        Start from one that ships with StoryOS, or from a blank page.
      </p>
      <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
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
    </div>
  );
}
