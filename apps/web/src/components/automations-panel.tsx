'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MousePointerClick, Play, Zap } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { ButtonActionsEditor } from '@/components/table-view/field-dialogs';
import type { ButtonAction } from '@/components/table-view/field-dialogs';
import { useDatabase } from '@/components/table-view/use-table-data';
import type { Field } from '@/components/table-view/use-table-data';
import { Button } from '@/components/ui/button';
import { DialogContent } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  trigger: { type: string; field_id?: string; every?: string; at?: string; weekday?: number };
  condition: { field: string; op: string; value?: unknown } | null;
  actions: ButtonAction[];
  failureStreak: number;
}

interface Run {
  id: string;
  status: string;
  error: string | null;
  durationMs: number | null;
  createdAt: string;
}

function triggerSentence(rule: Rule, fields: Field[]): string {
  const t = rule.trigger;
  if (t.type === 'record_created') return 'When a record is created';
  if (t.type === 'record_updated') {
    const field = fields.find((f) => f.id === t.field_id);
    return field ? `When "${field.displayName}" changes` : 'When a record changes';
  }
  if (t.type === 'schedule') return `Every ${t.every}${t.at ? ` at ${t.at}` : ''} (server time)`;
  return t.type;
}

/** Buttons & automations panel (MN-046/047) — Fibery's per-database sections. */
export function AutomationsPanel({ ws, db, onClose }: { ws: string; db: string; onClose: () => void }) {
  const qc = useQueryClient();
  const database = useDatabase(ws, db);
  const [tab, setTab] = useState<'rules' | 'buttons'>('rules');
  const [editing, setEditing] = useState<Rule | 'new' | null>(null);

  const rules = useQuery({
    queryKey: ['automations', ws, db],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/databases/{db}/automations', {
        params: { path: { ws, db } },
      } as never);
      if (error) throw error;
      return (data as unknown as { data: Rule[] }).data;
    },
  });

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['automations', ws, db] });

  const toggle = useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) => {
      const { error } = await api.PATCH('/api/v1/workspaces/{ws}/databases/{db}/automations/{id}', {
        params: { path: { ws, db, id } },
        body: { enabled } as never,
      } as never);
      if (error) throw error;
    },
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await api.DELETE('/api/v1/workspaces/{ws}/databases/{db}/automations/{id}', {
        params: { path: { ws, db, id } },
      } as never);
      if (error) throw error;
    },
    onSuccess: invalidate,
  });

  const buttons = (database.data?.fields ?? []).filter((f) => f.type === 'button');
  const fields = database.data?.fields ?? [];

  return (
    <DialogContent title={`Buttons & automations — ${database.data?.name ?? ''}`} className="max-w-2xl">
      <div className="flex max-h-[75vh] flex-col gap-3 overflow-y-auto pr-1">
        <div className="flex gap-1">
          {(['rules', 'buttons'] as const).map((t) => (
            <button
              key={t}
              className={cn(
                'flex items-center gap-1.5 rounded px-2.5 py-1 text-[13px] capitalize',
                tab === t ? 'bg-active font-medium text-ink' : 'text-muted hover:bg-hover',
              )}
              onClick={() => setTab(t)}
            >
              {t === 'rules' ? <Zap className="h-3.5 w-3.5" /> : <MousePointerClick className="h-3.5 w-3.5" />}
              {t === 'rules' ? 'Automation rules' : 'Buttons'}
            </button>
          ))}
        </div>

        {tab === 'buttons' && (
          <div className="flex flex-col gap-1.5">
            {buttons.length === 0 && (
              <p className="text-[13px] text-muted">
                No buttons yet — add a <strong>Button</strong> field from the table's "New field".
              </p>
            )}
            {buttons.map((b) => (
              <div key={b.id} className="rounded-[var(--radius-card)] border border-border-default p-3">
                <p className="text-[13px] font-medium text-ink">{b.displayName}</p>
                <p className="text-[12px] text-muted">
                  {((b.config['actions'] as ButtonAction[]) ?? []).map((a) => a.type.replace('_', ' ')).join(' → ')}
                </p>
              </div>
            ))}
          </div>
        )}

        {tab === 'rules' && !editing && (
          <>
            {(rules.data ?? []).map((rule) => (
              <RuleRow
                key={rule.id}
                ws={ws}
                db={db}
                rule={rule}
                fields={fields}
                onToggle={(enabled) => toggle.mutate({ id: rule.id, enabled })}
                onEdit={() => setEditing(rule)}
                onDelete={() => {
                  if (window.confirm(`Delete the rule "${rule.name}"?`)) remove.mutate(rule.id);
                }}
              />
            ))}
            {(rules.data ?? []).length === 0 && (
              <p className="text-[13px] text-muted">No rules yet. Rules run actions when records change or on a schedule.</p>
            )}
            <Button size="sm" className="self-start" onClick={() => setEditing('new')}>
              New rule
            </Button>
          </>
        )}

        {tab === 'rules' && editing && (
          <RuleEditor
            ws={ws}
            db={db}
            fields={fields}
            rule={editing === 'new' ? null : editing}
            onDone={() => {
              setEditing(null);
              invalidate();
            }}
          />
        )}

        <div className="flex justify-end">
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </DialogContent>
  );
}

function RuleRow({
  ws,
  db,
  rule,
  fields,
  onToggle,
  onEdit,
  onDelete,
}: {
  ws: string;
  db: string;
  rule: Rule;
  fields: Field[];
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [showRuns, setShowRuns] = useState(false);
  const runs = useQuery({
    queryKey: ['automation-runs', ws, db, rule.id],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/databases/{db}/automations/{id}/runs', {
        params: { path: { ws, db, id: rule.id } },
      } as never);
      if (error) throw error;
      return (data as unknown as { data: Run[] }).data;
    },
    enabled: showRuns,
  });

  return (
    <div className="rounded-[var(--radius-card)] border border-border-default p-3">
      <div className="flex items-center gap-2">
        <input type="checkbox" checked={rule.enabled} onChange={(e) => onToggle(e.target.checked)} title="Enabled" />
        <button className="min-w-0 flex-1 text-left" onClick={onEdit}>
          <p className="truncate text-[13px] font-medium text-ink">{rule.name}</p>
          <p className="truncate text-[12px] text-muted">
            {triggerSentence(rule, fields)} → {rule.actions.map((a) => a.type.replace('_', ' ')).join(', ')}
          </p>
        </button>
        <button className="text-[12px] text-muted hover:text-ink" onClick={() => setShowRuns((s) => !s)}>
          Runs
        </button>
        <button className="text-[12px] text-error hover:underline" onClick={onDelete}>
          Delete
        </button>
      </div>
      {!rule.enabled && rule.failureStreak >= 10 && (
        <p className="mt-1 text-[12px] text-warning">Auto-disabled after repeated failures — fix the actions and re-enable.</p>
      )}
      {showRuns && (
        <div className="mt-2 border-t border-border-default pt-2">
          {(runs.data ?? []).length === 0 && <p className="text-[12px] text-faint">No runs yet.</p>}
          {(runs.data ?? []).slice(0, 10).map((run) => (
            <p key={run.id} className="text-[12px] text-muted">
              <span
                className={cn(
                  'mr-1.5 inline-block h-1.5 w-1.5 rounded-full',
                  run.status === 'ok' ? 'bg-success' : run.status === 'error' ? 'bg-error' : 'bg-warning',
                )}
              />
              {new Date(run.createdAt).toLocaleString()} · {run.status}
              {run.error ? ` — ${run.error.slice(0, 80)}` : ''} · {run.durationMs}ms
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

const OPS_FOR_CONDITION: Record<string, Array<{ op: string; label: string }>> = {
  select: [{ op: 'has', label: 'is any of' }, { op: 'has_none', label: 'is none of' }, { op: 'is_empty', label: 'is empty' }],
  multi_select: [{ op: 'has', label: 'includes' }, { op: 'is_empty', label: 'is empty' }],
  checkbox: [{ op: 'eq', label: 'is' }],
  text: [{ op: 'contains', label: 'contains' }, { op: 'is_empty', label: 'is empty' }],
  title: [{ op: 'contains', label: 'contains' }],
  number: [{ op: 'gt', label: '>' }, { op: 'lt', label: '<' }, { op: 'eq', label: '=' }],
  date: [{ op: 'within', label: 'within' }, { op: 'is_empty', label: 'is empty' }],
  user: [{ op: 'has', label: 'is any of' }, { op: 'is_empty', label: 'is empty' }],
};

function RuleEditor({
  ws,
  db,
  fields,
  rule,
  onDone,
}: {
  ws: string;
  db: string;
  fields: Field[];
  rule: Rule | null;
  onDone: () => void;
}) {
  const [name, setName] = useState(rule?.name ?? '');
  const [triggerType, setTriggerType] = useState(rule?.trigger.type ?? 'record_updated');
  const [triggerFieldId, setTriggerFieldId] = useState(rule?.trigger.field_id ?? '');
  const [every, setEvery] = useState(rule?.trigger.every ?? 'day');
  const [at, setAt] = useState(rule?.trigger.at ?? '09:00');
  const [actions, setActions] = useState<ButtonAction[]>(rule?.actions ?? [{ type: 'add_comment', body_template: '' }]);
  const [conditionField, setConditionField] = useState(rule?.condition?.field ?? '');
  const [conditionOp, setConditionOp] = useState(rule?.condition?.op ?? '');
  const [conditionValue, setConditionValue] = useState<string>(() => {
    const v = rule?.condition?.value;
    if (Array.isArray(v)) return String(v[0] ?? '');
    return v === undefined ? '' : String(v);
  });
  const [busy, setBusy] = useState(false);

  const conditionable = fields.filter((f) => OPS_FOR_CONDITION[f.type]);
  const selectedConditionField = fields.find((f) => f.apiName === conditionField);
  const scopableFields = fields.filter((f) => !f.isSystem && f.type !== 'title');

  function buildCondition(): unknown {
    if (!conditionField || !conditionOp) return undefined;
    const field = selectedConditionField;
    if (!field) return undefined;
    if (conditionOp === 'is_empty' || conditionOp === 'not_empty') return { field: conditionField, op: conditionOp };
    let value: unknown = conditionValue;
    if (field.type === 'select' || field.type === 'multi_select') {
      const option = field.options?.find((o) => o.label === conditionValue || o.id === conditionValue);
      value = [option?.id ?? conditionValue];
    } else if (field.type === 'user') {
      value = [conditionValue];
    } else if (field.type === 'number') {
      value = Number(conditionValue);
    } else if (field.type === 'checkbox') {
      value = conditionValue === 'true';
    }
    return { field: conditionField, op: conditionOp, value };
  }

  async function save() {
    setBusy(true);
    const trigger =
      triggerType === 'schedule'
        ? { type: 'schedule', every, at }
        : triggerType === 'record_updated'
          ? { type: 'record_updated', ...(triggerFieldId ? { field_id: triggerFieldId } : {}) }
          : { type: triggerType };
    const body = { name, trigger, condition: buildCondition(), actions };
    const call = rule
      ? api.PATCH('/api/v1/workspaces/{ws}/databases/{db}/automations/{id}', {
          params: { path: { ws, db, id: rule.id } },
          body: body as never,
        } as never)
      : api.POST('/api/v1/workspaces/{ws}/databases/{db}/automations', {
          params: { path: { ws, db } },
          body: body as never,
        } as never);
    const { error } = await call;
    setBusy(false);
    if (error) {
      toast.error((error as { error?: { message?: string } })?.error?.message ?? 'Could not save the rule');
      return;
    }
    toast.success(rule ? 'Rule updated' : 'Rule created');
    onDone();
  }

  return (
    <div className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-border-default p-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="rule-name">Name</Label>
        <Input id="rule-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Escalate urgent tickets" />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label>When</Label>
        <div className="flex flex-wrap gap-2">
          <select
            className="h-8 rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-[13px] text-ink"
            value={triggerType}
            onChange={(e) => setTriggerType(e.target.value)}
          >
            <option value="record_created">A record is created</option>
            <option value="record_updated">A record changes</option>
            <option value="schedule">On a schedule</option>
          </select>
          {triggerType === 'record_updated' && (
            <select
              className="h-8 rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-[13px] text-ink"
              value={triggerFieldId}
              onChange={(e) => setTriggerFieldId(e.target.value)}
            >
              <option value="">any field</option>
              {scopableFields.map((f) => (
                <option key={f.id} value={f.id}>
                  only "{f.displayName}"
                </option>
              ))}
            </select>
          )}
          {triggerType === 'schedule' && (
            <>
              <select
                className="h-8 rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-[13px] text-ink"
                value={every}
                onChange={(e) => setEvery(e.target.value)}
              >
                <option value="hour">every hour</option>
                <option value="day">every day</option>
                <option value="week">every week</option>
              </select>
              {every !== 'hour' && (
                <Input className="h-8 w-24" value={at} onChange={(e) => setAt(e.target.value)} placeholder="09:00" />
              )}
            </>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label>Only if (optional)</Label>
        <div className="flex flex-wrap gap-2">
          <select
            className="h-8 rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-[13px] text-ink"
            value={conditionField}
            onChange={(e) => {
              setConditionField(e.target.value);
              setConditionOp('');
            }}
          >
            <option value="">no condition</option>
            {conditionable.map((f) => (
              <option key={f.id} value={f.apiName}>
                {f.displayName}
              </option>
            ))}
          </select>
          {selectedConditionField && (
            <select
              className="h-8 rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-[13px] text-ink"
              value={conditionOp}
              onChange={(e) => setConditionOp(e.target.value)}
            >
              <option value="">op…</option>
              {(OPS_FOR_CONDITION[selectedConditionField.type] ?? []).map((o) => (
                <option key={o.op} value={o.op}>
                  {o.label}
                </option>
              ))}
            </select>
          )}
          {selectedConditionField && conditionOp && conditionOp !== 'is_empty' && (
            selectedConditionField.type === 'select' || selectedConditionField.type === 'multi_select' ? (
              <select
                className="h-8 rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-[13px] text-ink"
                value={conditionValue}
                onChange={(e) => setConditionValue(e.target.value)}
              >
                <option value="">option…</option>
                {(selectedConditionField.options ?? []).map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : (
              <Input className="h-8 w-40" value={conditionValue} onChange={(e) => setConditionValue(e.target.value)} />
            )
          )}
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label>Then</Label>
        <ButtonActionsEditor ws={ws} db={db} fields={fields} actions={actions} onChange={setActions} />
      </div>

      <div className="flex justify-end gap-2">
        <Button variant="secondary" size="sm" onClick={onDone}>
          Cancel
        </Button>
        <Button size="sm" disabled={busy || !name.trim() || actions.length === 0} onClick={save}>
          <Play className="mr-1 h-3.5 w-3.5" /> Save rule
        </Button>
      </div>
    </div>
  );
}
