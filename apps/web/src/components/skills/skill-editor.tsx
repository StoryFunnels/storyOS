'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { ArrowLeft, Copy, Download } from 'lucide-react';
import { toast } from 'sonner';
import { skillVersionSchema } from '@storyos/schemas';
import type { SkillExportFormat, SkillSummary, SkillTemplate, SkillVisibility } from '@storyos/schemas';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useMembers } from '@/components/table-view/use-table-data';
import { apiErrorMessage } from '@/lib/api';
import { useSession } from '@/lib/auth-client';
import { cn } from '@/lib/utils';
import { MarkedText, SkillSourceMark } from './skill-bits';
import {
  CLOSE_THRESHOLD,
  DISCOVERY_BUDGET_TOKENS,
  compareToRivals,
  discoveryBlock,
  estimateTokens,
  type Verdict,
} from './skill-compare';
import { VISIBILITY_CHIP, VISIBILITY_OPTIONS, audienceProblem, narrowingMessage, narrowsAudience, publicSkillPageUrl } from './skill-meta';
import { fetchSkillExport, useSkillMutations, useSkills } from './use-skills';

/** What the form holds. Strings only: validation is the schema's, on save. */
export interface SkillDraft {
  name: string;
  description: string;
  when_to_use: string;
  instructions: string;
  visibility: SkillVisibility;
  /** Semver. Empty on a new skill means "let the server pick its default". */
  version: string;
  /** Only sent while `visibility` is `members`. The owner is always included by the server. */
  member_ids: string[];
}

export function draftFromSkill(skill: SkillSummary): SkillDraft {
  return {
    name: skill.name,
    description: skill.description,
    when_to_use: skill.when_to_use,
    instructions: skill.instructions,
    visibility: skill.visibility,
    version: skill.version,
    member_ids: skill.member_ids ?? [],
  };
}

/** A new skill starts from a scaffold when one was chosen, and defaults to
 * WORKSPACE visibility (parent ticket #832) — not the API's `personal`, which
 * is how skills ended up stuck where nobody else's AI could find them. */
export function draftFromTemplate(t: SkillTemplate | undefined): SkillDraft {
  return {
    name: t?.name === 'Blank' ? '' : (t?.name ?? ''),
    description: t?.description ?? '',
    when_to_use: t?.when_to_use ?? '',
    instructions: t?.instructions ?? '',
    visibility: 'shared',
    version: '',
    member_ids: [],
  };
}

/** The control's order: narrowest audience first, as the prototype draws it, then the public link. */
const SEGMENT_ORDER: SkillVisibility[] = ['personal', 'members', 'shared', 'public'];

const LIMITS = { name: 100, description: 500, when_to_use: 1000, instructions: 20_000 } as const;

/** Why a draft cannot be saved yet, or null. Mirrors the API's schema bounds so
 * the button explains itself rather than the server answering 422. */
export function draftProblem(d: SkillDraft, ownerId?: string): string | null {
  if (!d.name.trim()) return 'Give the skill a name.';
  if (!d.description.trim()) return 'Add a one-line description.';
  if (!d.when_to_use.trim()) return 'Say when a model should use it.';
  if (!d.instructions.trim()) return 'Add the instructions.';
  for (const k of ['name', 'description', 'when_to_use', 'instructions'] as const) {
    if (d[k].length > LIMITS[k]) return `${k.replace('_', ' ')} is over ${LIMITS[k].toLocaleString()} characters.`;
  }
  if (d.version.trim() && !skillVersionSchema.safeParse(d.version).success) return 'Version must look like 1.2.0.';
  return audienceProblem(d.visibility, d.member_ids, ownerId);
}

/** The wire body: `member_ids` only travels with `members`, and an empty version is left for the server to default. */
export function draftBody(d: SkillDraft): Record<string, unknown> {
  const { member_ids, version, ...rest } = d;
  return {
    ...rest,
    ...(version.trim() ? { version: version.trim() } : {}),
    ...(d.visibility === 'members' ? { member_ids } : {}),
  };
}

export function SkillEditor({
  ws,
  skill,
  template,
}: {
  ws: string;
  /** Present when editing; absent for a new skill. */
  skill?: SkillSummary;
  template?: SkillTemplate;
}) {
  const router = useRouter();
  const confirm = useConfirm();
  const { create, update, remove } = useSkillMutations(ws);
  const all = useSkills(ws);
  const initial = useMemo(() => (skill ? draftFromSkill(skill) : draftFromTemplate(template)), [skill, template]);
  const [draft, setDraft] = useState<SkillDraft>(initial);
  const readOnly = skill ? !skill.editable : false;
  const set = <K extends keyof SkillDraft>(k: K, v: SkillDraft[K]) => setDraft((d) => ({ ...d, [k]: v }));

  const dirty = (Object.keys(initial) as Array<keyof SkillDraft>).some((k) => JSON.stringify(initial[k]) !== JSON.stringify(draft[k]));
  const session = useSession();
  const ownerId = skill?.owner_id ?? session.data?.user?.id;
  const people = useMembers(ws, true);
  const problem = draftProblem(draft, ownerId);
  const saving = create.isPending || update.isPending;

  const rivals = useMemo(
    () =>
      (all.data ?? [])
        .filter((s) => s.id !== skill?.id)
        .map((s) => ({ id: s.id, name: s.name, when_to_use: s.when_to_use })),
    [all.data, skill?.id],
  );
  const comparison = useMemo(() => compareToRivals(draft.when_to_use, rivals), [draft.when_to_use, rivals]);
  const block = discoveryBlock(draft);
  const tokens = estimateTokens(block);

  async function save() {
    if (problem || readOnly) return;
    if (skill) {
      if (narrowsAudience(skill.visibility, draft.visibility)) {
        const ok = await confirm({
          title: `Change who can see “${skill.name}”?`,
          message: narrowingMessage(skill.visibility, draft.visibility),
          confirmLabel: 'Change visibility',
        });
        if (!ok) return;
      }
      await update.mutateAsync({ id: skill.id, body: draftBody(draft) as never });
      router.push(`/w/${ws}/skills`);
    } else {
      await create.mutateAsync({
        ...draftBody(draft),
        examples: template?.examples ?? [],
        source_template: template && template.id !== 'blank' ? template.id : undefined,
      } as never);
      router.push(`/w/${ws}/skills`);
    }
  }

  async function onDelete() {
    if (!skill) return;
    const ok = await confirm({
      title: `Delete "${skill.name}"?`,
      message:
        skill.visibility === 'shared'
          ? 'Everyone in the workspace, and their AI, loses access to it. This cannot be undone.'
          : 'This cannot be undone.',
      confirmLabel: 'Delete skill',
      danger: true,
    });
    if (!ok) return;
    await remove.mutateAsync(skill.id);
    router.push(`/w/${ws}/skills`);
  }

  return (
    <div className="w-full max-w-[1080px] px-7 pb-[60px] pt-[22px]">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-2 border-b border-border-default px-5 py-3">
        <Link
          href={`/w/${ws}/skills`}
          aria-label="Back to Skills"
          className="rounded p-1 text-muted hover:bg-hover hover:text-ink"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <h1 className="min-w-0 max-w-full truncate text-title font-bold tracking-tight text-ink">{skill ? skill.name : 'New skill'}</h1>
        {skill && <SkillSourceMark source={skill.source} />}
        <span className="text-label text-muted">{skill ? (readOnly ? 'read only' : 'editing') : 'new'}</span>
        <span className="flex-1 max-sm:hidden" />
        {skill && <ExportControl ws={ws} id={skill.id} />}
        {skill && !readOnly && (
          <Button variant="destructive" size="sm" onClick={() => void onDelete()} disabled={remove.isPending}>
            Delete
          </Button>
        )}
        {!readOnly && (
          <Button size="sm" onClick={() => void save()} disabled={Boolean(problem) || (Boolean(skill) && !dirty) || saving} title={problem ?? undefined}>
            {saving ? 'Saving…' : skill ? 'Save' : 'Create skill'}
          </Button>
        )}
      </div>

      {readOnly && (
        <p className="border-b border-border-default bg-hover px-5 py-2 text-label text-muted">
          Only the author can edit this skill. You can read it, and your AI can find and run it.
        </p>
      )}

      <div className="grid grid-cols-[minmax(0,640px)] max-md:grid-cols-1 xl:grid-cols-[minmax(0,640px)_22rem] xl:gap-6">
        <div className="flex min-w-0 flex-col gap-4 px-5 py-4">
          <Field label="Name" count={draft.name.length} max={LIMITS.name}>
            <Input value={draft.name} disabled={readOnly} maxLength={LIMITS.name} onChange={(e) => set('name', e.target.value)} />
          </Field>

          <Field label="Version" hint="Semver, like 1.2.0. Bump it when the wording changes so a reader can tell which copy they have.">
            <Input
              className="w-40 font-mono"
              value={draft.version}
              placeholder={skill ? undefined : '1.0.0'}
              disabled={readOnly}
              maxLength={64}
              onChange={(e) => set('version', e.target.value)}
            />
          </Field>

          <Field label="Description" tag="model reads" count={draft.description.length} max={LIMITS.description}>
            <Textarea
              size="sm"
              value={draft.description}
              disabled={readOnly}
              maxLength={LIMITS.description}
              onChange={(e) => set('description', e.target.value)}
            />
          </Field>

          <Field
            label="When to use"
            tag="model selects on this"
            count={draft.when_to_use.length}
            max={LIMITS.when_to_use}
            hint="Read at discovery, before the instructions are ever loaded: this text is the entire basis on which a model chooses between this skill and the one beside it. Name the trigger, not the output — when does this apply, rather than what it produces."
          >
            <Textarea
              value={draft.when_to_use}
              disabled={readOnly}
              maxLength={LIMITS.when_to_use}
              onChange={(e) => set('when_to_use', e.target.value)}
            />
          </Field>

          <Field
            label="Instructions"
            count={draft.instructions.length}
            max={LIMITS.instructions}
            hint="Loaded only when the skill is activated, so it does not compete for the discovery budget. Length matters far less here than in the two fields above."
          >
            <Textarea
              className="min-h-48 font-mono text-label"
              value={draft.instructions}
              disabled={readOnly}
              maxLength={LIMITS.instructions}
              onChange={(e) => set('instructions', e.target.value)}
            />
          </Field>

          <div className="flex flex-col gap-1.5" role="group" aria-labelledby="skill-visibility-label">
            <span id="skill-visibility-label" className="text-label font-semibold text-ink-secondary">
              Who can see it
            </span>
            {/* #997 — the prototype's segmented control. All FOUR audiences stay (it drew three; "Anyone with the
                link" shipped with #841 and is not dropped), each with the plain-words hint of the chosen one underneath,
                and each tier's own detail (the people list, the public link) under it. A read-only viewer sees the
                audience but every segment is disabled. */}
            <Segmented
              label="Who can see it"
              value={draft.visibility}
              onChange={(v) => !readOnly && set('visibility', v)}
              options={SEGMENT_ORDER.map((value) => ({ value, label: VISIBILITY_CHIP[value], disabled: readOnly }))}
              size="default"
              className="w-full"
              itemClassName="flex-1"
            />
            {VISIBILITY_OPTIONS.filter((o) => o.value === draft.visibility).map((o) => (
              <div key={o.value} className="flex flex-col gap-1.5">
                <p className="text-label text-muted">
                  <span className="font-medium text-ink-secondary">{o.label}.</span> {o.hint}
                </p>
                {o.value === 'members' && (
                  <MemberPicker
                    people={people.data ?? []}
                    loading={people.isPending}
                    ownerId={ownerId}
                    selected={draft.member_ids}
                    disabled={readOnly}
                    onChange={(ids) => set('member_ids', ids)}
                  />
                )}
                {o.value === 'public' && (
                  <PublicLink url={publicSkillPageUrl(window.location.origin, skill?.public_token)} saved={skill?.visibility === 'public'} />
                )}
              </div>
            ))}
          </div>

          {problem && !readOnly && (dirty || !skill) && <p className="text-label text-muted">{problem}</p>}
        </div>

        <aside className="min-w-0 border-t border-border-default p-4 xl:border-l xl:border-t-0">
          <section className="rounded-[var(--radius-card)] bg-hover p-3" aria-label="Will a model pick this one?">
            <h2 className="text-body font-bold tracking-tight text-ink">Will a model pick this one?</h2>
            <p className="mb-3 mt-0.5 text-label leading-normal text-muted">
              Your <code className="font-mono">when_to_use</code> against its closest neighbours in this workspace.{' '}
              <span className="rounded-sm bg-error/15 px-0.5 text-error underline decoration-dotted underline-offset-2">Underlined red</span> is wording
              you share with a rival; <span className="rounded-sm bg-success/15 px-0.5 font-semibold text-success">bold green</span> is what only you say.
              This compares the text only — it runs nothing.
            </p>

            {comparison.verdict.kind === 'empty' ? (
              <p className="text-label text-muted">Write the “when to use” sentence and it will be set beside its nearest rivals here.</p>
            ) : (
              <>
                <div className="mb-2 border-l-2 border-primary-text py-1 pl-2.5">
                  <p className="text-label font-bold text-ink">
                    {draft.name.trim() || 'This skill'} <span className="font-mono text-micro tracking-wider text-primary-text">YOU</span>
                  </p>
                  <p className="mt-0.5 text-label leading-normal text-muted">
                    <MarkedText segments={comparison.mine} />
                  </p>
                </div>
                {comparison.rivals.map((r) => (
                  <div key={r.id} className="mb-2 border-l-2 border-border-default py-1 pl-2.5">
                    <p className="text-label font-bold text-ink">{r.name}</p>
                    <p className="mt-0.5 text-label leading-normal text-muted">
                      <MarkedText segments={r.segments} />
                    </p>
                  </div>
                ))}
                <VerdictNote verdict={comparison.verdict} />
              </>
            )}
          </section>

          <section className="mt-3 rounded-[var(--radius-card)] bg-hover p-3" aria-label="What the model actually receives">
            <div className="mb-1.5 flex items-center justify-between">
              <h3 className="font-mono text-micro uppercase tracking-wider text-muted">what a reader’s AI sees first</h3>
              <span
                className="font-mono text-micro text-muted"
                title="A rough estimate (about 4 characters per token), not a tokenizer. Every skill's discovery text shares one budget."
              >
                ~{tokens} of ~{DISCOVERY_BUDGET_TOKENS.toLocaleString()} tokens (est.)
              </span>
            </div>
            <pre className="whitespace-pre-wrap font-mono text-micro leading-relaxed text-ink-secondary">{block}</pre>
          </section>
        </aside>
      </div>
    </div>
  );
}

function VerdictNote({ verdict }: { verdict: Verdict }) {
  if (verdict.kind === 'close') {
    return (
      <p className="mt-2 rounded-[var(--radius-control)] border border-error/30 bg-error/10 p-2 text-label leading-normal text-error" role="status">
        <b>Too close to call.</b> Your wording overlaps “{verdict.nearest}”
        {verdict.sharedWords.length > 0 && <> on {verdict.sharedWords.map((w) => `“${w}”`).join(', ')}</>}. A model asked to do either
        has little to separate them. <b>Name the trigger, not the output.</b>
        <span className="mt-1 block text-micro opacity-80">
          Compares shared wording only (overlap ≥ {Math.round(CLOSE_THRESHOLD * 100)}%), not meaning.
        </span>
      </p>
    );
  }
  if (verdict.kind === 'distinct') {
    return (
      <p className="mt-2 rounded-[var(--radius-control)] border border-border-default bg-card p-2 text-label leading-normal text-ink-secondary" role="status">
        <b>Distinct from its nearest neighbour</b>, “{verdict.nearest}”, by wording. That is a lexical check, not proof a model will choose
        correctly.
      </p>
    );
  }
  if (verdict.kind === 'alone') {
    return (
      <p className="mt-2 text-label leading-normal text-muted" role="status">
        No other skills here to compare against yet. Write the trigger, not the output: when does this apply, rather than what it produces.
      </p>
    );
  }
  return null;
}

function Field({
  label,
  tag,
  hint,
  count,
  max,
  children,
}: {
  label: string;
  tag?: string;
  hint?: string;
  count?: number;
  max?: number;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center gap-1.5 whitespace-nowrap text-label font-semibold text-ink-secondary">
        {label}
        {tag && (
          <span className="rounded-sm bg-accent-soft px-1 font-mono text-micro font-bold uppercase tracking-wider text-accent">{tag}</span>
        )}
        <span className="flex-1" />
        {count !== undefined && max !== undefined && (
          <span className={cn('font-normal tabular-nums text-muted', count > max * 0.9 && 'text-warning')}>
            {count.toLocaleString()}/{max.toLocaleString()}
          </span>
        )}
      </div>
      {children}
      {hint && <p className="mt-1 text-label leading-normal text-muted">{hint}</p>}
    </div>
  );
}

function MemberPicker({
  people,
  loading,
  ownerId,
  selected,
  disabled,
  onChange,
}: {
  people: Array<{ user: { id: string; name: string } }>;
  loading: boolean;
  ownerId: string | undefined;
  selected: string[];
  disabled: boolean;
  onChange: (ids: string[]) => void;
}) {
  // The owner always has it; listing them as a choice would offer a toggle that does nothing.
  const others = people.filter((m) => m.user.id !== ownerId);
  const toggle = (id: string) => onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  return (
    <div className="flex flex-col gap-1 rounded-[var(--radius-control)] border border-border-default bg-card p-2" role="group" aria-label="People who can see this skill">
      <p className="text-label font-semibold text-ink-secondary">Share with</p>
      {loading && <p className="text-label text-muted">Loading people…</p>}
      {!loading && others.length === 0 && <p className="text-label text-muted">There is nobody else in this workspace to share it with yet.</p>}
      {others.map((m) => (
        <label key={m.user.id} className="flex cursor-pointer items-center gap-2 text-body text-ink">
          <input type="checkbox" disabled={disabled} checked={selected.includes(m.user.id)} onChange={() => toggle(m.user.id)} />
          {m.user.name}
        </label>
      ))}
    </div>
  );
}

function PublicLink({ url, saved }: { url: string | null; saved: boolean }) {
  async function copy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Link copied');
    } catch {
      toast.error('Could not copy — select the link and copy it by hand');
    }
  }
  if (!saved || !url) {
    return <p className="text-label text-muted">The link is created when you save.</p>;
  }
  return (
    <div className="flex items-center gap-2">
      <Input readOnly value={url} aria-label="Public link" className="font-mono text-label" onFocus={(e) => e.currentTarget.select()} />
      <Button type="button" variant="secondary" size="sm" onClick={() => void copy()}>
        <Copy className="mr-1 h-3 w-3" /> Copy
      </Button>
    </div>
  );
}

const EXPORT_FORMATS: Array<{ value: SkillExportFormat; label: string }> = [
  { value: 'markdown', label: 'Markdown' },
  { value: 'claude_skill', label: 'Claude skill (SKILL.md)' },
  { value: 'chatgpt', label: 'ChatGPT instructions' },
];

/** Export the SAVED skill — what the server renders, not the unsaved draft — as a file download. */
function ExportControl({ ws, id }: { ws: string; id: string }) {
  const [format, setFormat] = useState<SkillExportFormat>('markdown');
  const [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true);
    try {
      const out = await fetchSkillExport(ws, id, format);
      const url = URL.createObjectURL(new Blob([out.content], { type: 'text/markdown;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = out.filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Could not export the skill'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <span className="flex items-center gap-1">
      <Select size="sm" value={format} onChange={(e) => setFormat(e.target.value as SkillExportFormat)} aria-label="Export format">
        {EXPORT_FORMATS.map((f) => (
          <option key={f.value} value={f.value}>
            {f.label}
          </option>
        ))}
      </Select>
      <Button variant="secondary" size="sm" disabled={busy} onClick={() => void run()}>
        <Download className="mr-1 h-3 w-3" /> {busy ? 'Exporting…' : 'Export'}
      </Button>
    </span>
  );
}
