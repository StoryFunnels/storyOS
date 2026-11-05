'use client';

import { X } from 'lucide-react';
import { MenuSelect } from '@/components/ui/menu-select';
import type { Field } from '@/components/table-view/use-table-data';
import { Button } from '@/components/ui/button';
import { agentRelationField, everyOptions, hasTimeOfDay, isWatchableField, newRule, offersWindow, runsNote, singular, TIME_STEPS, WEEKDAY_CHOICES, zoneLabel } from '@/lib/runners/wake-rules';
import type { WakeRule, WakeRuleKind } from '@/lib/runners/wake-rules';
import type { WorkTarget } from '@/lib/runners/hire';
import { canBindAgentToAssignment } from '@/lib/runners/access';
import type { Caps } from '@/lib/runners/hire-capabilities';

type DbTarget = Extract<WorkTarget, { kind: 'db' }>;

/**
 * Ticket #1196 — "Wakes when": a list of rules, each built from the product's OWN menus (`MenuSelect`, the Sort builder's pattern),
 * never a native select or time input. What is offered is what the API accepts today (`wake-rules.ts`, `hire-capabilities.ts`).
 * The note under the list is the time-zone sentence whenever a rule has a time; the zone is the person's own.
 */
export function WakeRulesEditor({
  rules,
  onChange,
  works,
  fieldsByDb,
  agentsDbId,
  role,
  timeZone,
  caps,
}: {
  rules: WakeRule[];
  onChange: (rules: WakeRule[]) => void;
  works: DbTarget[];
  fieldsByDb: Record<string, Field[] | undefined>;
  agentsDbId: string;
  role: string | undefined;
  timeZone: string;
  caps?: Caps;
}) {
  const set = (i: number, patch: Partial<WakeRule>) => onChange(rules.map((r, j) => (j === i ? ({ ...r, ...patch } as WakeRule) : r)));
  const remove = (i: number) => onChange(rules.filter((_, j) => j !== i));
  const dbOptions = works.map((w) => ({ value: w.id, label: w.name }));
  const assignDbs = works.filter((w) => agentRelationField(fieldsByDb[w.id], agentsDbId));
  const hasTime = rules.some((r) => r.kind === 'sched' && hasTimeOfDay(r.every));

  const kinds: Array<{ value: WakeRuleKind | ''; label: string; disabled?: boolean }> = [
    { value: '', label: '+ Add a way to wake it' },
    { value: 'sched', label: 'On a schedule' },
    { value: 'field', label: 'When a field changes', disabled: works.length === 0 },
    { value: 'new', label: 'When a new record is added', disabled: works.length === 0 },
    ...(canBindAgentToAssignment(role) && assignDbs.length > 0 ? [{ value: 'assign' as const, label: 'When you assign it a record' }] : []),
  ];

  function add(kind: WakeRuleKind | '') {
    if (!kind) return;
    const first = works[0]?.id ?? null;
    if (kind === 'assign') {
      const db = assignDbs[0];
      if (!db) return;
      onChange([...rules, newRule('assign', { databaseId: db.id, relationFieldId: agentRelationField(fieldsByDb[db.id], agentsDbId)?.id ?? null }, caps)]);
      return;
    }
    onChange([...rules, newRule(kind, { databaseId: first }, caps)]);
  }

  return (
    <div className="flex flex-col gap-1.5" data-testid="wake-rules">
      {rules.length === 0 && <p className="m-0 text-label text-muted">Only when you start it.</p>}
      {rules.map((r, i) => (
        <div key={i} data-testid="wake-rule" data-kind={r.kind}>
          <div className="flex flex-wrap items-center gap-1.5 text-body text-ink-secondary">
            {r.kind === 'sched' && (
              <>
                <span>Every</span>
                <MenuSelect
                  label="How often"
                  value={r.every}
                  options={everyOptions(caps).map((o) => ({ value: o.value, label: o.label }))}
                  onChange={(v) => set(i, { every: v as typeof r.every })}
                  className="min-w-0 max-w-none"
                />
                {r.every === 'week' && (
                  <>
                    <span>on</span>
                    <MenuSelect label="Day of the week" value={String(r.weekday)} options={WEEKDAY_CHOICES.map((d) => ({ value: String(d.value), label: d.label }))} onChange={(v) => set(i, { weekday: Number(v) })} className="min-w-0 max-w-none" />
                  </>
                )}
                {hasTimeOfDay(r.every) && (
                  <>
                    <span>at</span>
                    <MenuSelect label="Time" value={r.at} options={TIME_STEPS.map((t) => ({ value: t, label: t }))} onChange={(v) => set(i, { at: v })} className="min-w-[4.5rem] max-w-none" contentClassName="w-24" />
                  </>
                )}
                {offersWindow(r.every, caps) && (
                  <label className="flex items-center gap-1.5 text-label text-ink-secondary">
                    <input type="checkbox" checked={r.window} onChange={(e) => set(i, { window: e.target.checked })} />
                    only 9:00–18:00
                  </label>
                )}
              </>
            )}
            {r.kind === 'field' && (
              <>
                <span>When a</span>
                <MenuSelect label="Database" value={r.databaseId ?? ''} options={dbOptions.map((o) => ({ ...o, label: singular(String(o.label)) }))} onChange={(v) => set(i, { databaseId: v, fieldId: null })} className="min-w-0 max-w-none" />
                <span>’s</span>
                <FieldMenu fields={r.databaseId ? fieldsByDb[r.databaseId] : undefined} value={r.fieldId} onChange={(fieldId) => set(i, { fieldId })} />
                <span>changes</span>
              </>
            )}
            {r.kind === 'new' && (
              <>
                <span>When a new</span>
                <MenuSelect label="Database" value={r.databaseId ?? ''} options={dbOptions.map((o) => ({ ...o, label: singular(String(o.label)) }))} onChange={(v) => set(i, { databaseId: v })} className="min-w-0 max-w-none" />
                <span>is added</span>
              </>
            )}
            {r.kind === 'assign' && (
              <>
                <span>When you assign it a record in</span>
                <MenuSelect
                  label="Database"
                  value={r.databaseId ?? ''}
                  options={assignDbs.map((w) => ({ value: w.id, label: w.name }))}
                  onChange={(v) => set(i, { databaseId: v, relationFieldId: agentRelationField(fieldsByDb[v], agentsDbId)?.id ?? null })}
                  className="min-w-0 max-w-none"
                />
              </>
            )}
            <Button type="button" variant="ghost" size="sm" className="ml-auto h-6 w-6 px-0 text-muted" onClick={() => remove(i)} aria-label="Remove this way to wake it">
              <X className="h-3.5 w-3.5" aria-hidden />
            </Button>
          </div>
          {r.kind === 'sched' && <p className="mb-0 mt-1 text-label text-muted">{runsNote(r, timeZone, caps)}</p>}
        </div>
      ))}
      <div>
        <MenuSelect label="Add a way to wake it" value="" options={kinds} onChange={(v) => add(v as WakeRuleKind | '')} className="max-w-none" contentClassName="w-60" align="start" />
      </div>
      <p className="m-0 text-label text-muted">
        {hasTime ? `Times are in your time zone, ${zoneLabel(timeZone)}. ` : ''}It also wakes whenever you start it by hand.
      </p>
    </div>
  );
}

function FieldMenu({ fields, value, onChange }: { fields: Field[] | undefined; value: string | null; onChange: (id: string) => void }) {
  const options = (fields ?? []).filter(isWatchableField).map((f) => ({ value: f.id, label: f.displayName }));
  return (
    <MenuSelect
      label="Field"
      value={value ?? ''}
      options={options.length ? [...(value ? [] : [{ value: '', label: 'Choose a field', disabled: true }]), ...options] : [{ value: '', label: fields ? 'No field to watch' : 'Loading…', disabled: true }]}
      onChange={onChange}
      className="min-w-0 max-w-none"
    />
  );
}
