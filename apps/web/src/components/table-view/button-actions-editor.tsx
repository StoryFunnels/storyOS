'use client';

import { Info, Plus, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useDatabases } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { useDatabase, useMembers } from './use-table-data';
import type { Field } from './use-table-data';

export type ButtonAction =
  | { type: 'set_values'; values: Record<string, unknown> }
  | { type: 'create_record'; database_id: string; values: Record<string, unknown>; link_via_relation_field_id?: string }
  | { type: 'add_comment'; body_template: string }
  | { type: 'notify_user'; user: string; message: string }
  | { type: 'update_linked'; relation_field_id: string; values: Record<string, unknown> }
  // A secret header value is write-only (#249): reads return the `{ __keep: true }`
  // presence flag in its place, and echoing it back on save keeps the stored value.
  | { type: 'send_webhook'; url: string; body_template?: string; headers?: Record<string, string | { __keep: true }> };

type Member = { id: string; name: string };

/** Compact declarative action builder: set fields / create linked record / comment. */
export function ButtonActionsEditor({
  ws,
  db,
  fields: dbFields,
  actions,
  onChange,
}: {
  ws: string;
  db: string;
  fields: Field[];
  actions: ButtonAction[];
  onChange: (actions: ButtonAction[]) => void;
}) {
  const databases = useDatabases(ws);
  const membersQuery = useMembers(ws, true);
  const members = (membersQuery.data ?? []).map((m) => ({ id: m.user.id, name: m.user.name }));
  const settable = dbFields.filter(
    (f) => !f.isSystem && !['title', 'relation', 'lookup', 'rollup', 'button', 'rich_text', 'created_at', 'updated_at', 'created_by'].includes(f.type),
  );
  const userFields = dbFields.filter((f) => f.type === 'user');
  const relationFields = dbFields.filter((f) => f.type === 'relation');

  function patch(i: number, next: ButtonAction) {
    onChange(actions.map((a, j) => (j === i ? next : a)));
  }

  return (
    <div className="flex flex-col gap-2">
      {actions.map((action, i) => (
        <div key={i} className="flex flex-col gap-1.5 rounded-[var(--radius-card)] border border-border-default p-2">
          <div className="flex items-center gap-2">
            <select
              className="h-8 flex-1 rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-[13px] text-ink"
              value={action.type}
              onChange={(e) => {
                const t = e.target.value;
                if (t === 'set_values') patch(i, { type: 'set_values', values: {} });
                else if (t === 'create_record') patch(i, { type: 'create_record', database_id: db, values: { name: 'New record for {Title}' } });
                else if (t === 'notify_user') patch(i, { type: 'notify_user', user: '@me', message: '' });
                else if (t === 'update_linked') patch(i, { type: 'update_linked', relation_field_id: relationFields[0]?.id ?? '', values: {} });
                else if (t === 'send_webhook') patch(i, { type: 'send_webhook', url: '' });
                else patch(i, { type: 'add_comment', body_template: '' });
              }}
            >
              <option value="set_values">Set fields on this record</option>
              <option value="create_record">Create a record</option>
              <option value="update_linked">Update linked records</option>
              <option value="add_comment">Add a comment</option>
              <option value="notify_user">Notify a person</option>
              <option value="send_webhook">Send a webhook</option>
            </select>
            <button type="button" className="p-1 text-faint hover:text-error" onClick={() => onChange(actions.filter((_, j) => j !== i))}>
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>

          {action.type === 'set_values' && (
            <FieldValuesEditor
              settable={settable}
              members={members}
              values={action.values}
              addLabel="＋ field to set…"
              onChange={(values) => patch(i, { ...action, values })}
            />
          )}

          {action.type === 'create_record' && (
            <div className="flex flex-col gap-1">
              <select
                className="h-7 rounded border border-border-default bg-card px-1 text-[12px] text-ink"
                value={action.database_id}
                onChange={(e) => patch(i, { ...action, database_id: e.target.value, link_via_relation_field_id: undefined })}
              >
                {(databases.data ?? []).map((d) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </select>
              <Input
                className="h-7"
                placeholder="Title template — {Title} inserts this record's title"
                value={String(action.values.name ?? '')}
                onChange={(e) => patch(i, { ...action, values: { ...action.values, name: e.target.value } })}
              />
              <LinkBackPicker ws={ws} sourceDb={db} targetDb={action.database_id} value={action.link_via_relation_field_id} onChange={(v) => patch(i, { ...action, link_via_relation_field_id: v })} />
            </div>
          )}

          {action.type === 'add_comment' && (
            <Input
              className="h-7"
              placeholder="Comment text — {Field Name} interpolates values"
              value={action.body_template}
              onChange={(e) => patch(i, { ...action, body_template: e.target.value })}
            />
          )}

          {action.type === 'send_webhook' && (
            <div className="flex flex-col gap-1">
              {!action.url.trim() && (
                <div className="flex items-start gap-1.5 rounded border border-border-default bg-hover px-2 py-1.5 text-[11px] text-muted">
                  <Info className="mt-0.5 h-3 w-3 shrink-0" />
                  <span>
                    This sends data to a URL you choose — paste in the webhook URL your
                    automation tool (n8n, Make, Zapier) gives you, or your own endpoint.{' '}
                    <Link
                      href={`/w/${ws}/settings/webhooks`}
                      target="_blank"
                      className="underline underline-offset-2 hover:no-underline"
                    >
                      See how webhooks work
                    </Link>
                    .
                  </span>
                </div>
              )}
              <Input
                className="h-7"
                type="url"
                placeholder="https://hooks.example.com/... — {Field Name} interpolates"
                value={action.url}
                onChange={(e) => patch(i, { ...action, url: e.target.value })}
              />
              <textarea
                className="min-h-[56px] rounded border border-border-default bg-card px-2 py-1 font-mono text-[12px] text-ink"
                placeholder={'Body (optional) — JSON is sent as-is, {Field Name} interpolates.\nLeave empty to send the whole record.'}
                value={action.body_template ?? ''}
                onChange={(e) => patch(i, { ...action, body_template: e.target.value || undefined })}
              />
              <p className="text-[11px] text-faint">
                Signed with the workspace webhook secret; failures retry automatically.
              </p>
            </div>
          )}

          {action.type === 'notify_user' && (
            <div className="flex flex-col gap-1">
              <select
                className="h-7 rounded border border-border-default bg-card px-1 text-[12px] text-ink"
                value={action.user}
                onChange={(e) => patch(i, { ...action, user: e.target.value })}
              >
                <option value="@me">Me (whoever runs it)</option>
                {userFields.map((f) => (
                  <option key={f.id} value={f.apiName}>{f.displayName}</option>
                ))}
              </select>
              <Input
                className="h-7"
                placeholder="Message — {Field Name} interpolates values"
                value={action.message}
                onChange={(e) => patch(i, { ...action, message: e.target.value })}
              />
            </div>
          )}

          {action.type === 'update_linked' && (
            <UpdateLinkedEditor
              ws={ws}
              relationFields={relationFields}
              members={members}
              action={action}
              onChange={(next) => patch(i, next)}
            />
          )}
        </div>
      ))}
      <button
        type="button"
        className="flex items-center gap-1 self-start text-[13px] text-muted hover:text-ink"
        onClick={() => onChange([...actions, { type: 'add_comment', body_template: '' }])}
      >
        <Plus className="h-3.5 w-3.5" /> Add action
      </button>
    </div>
  );
}

/** Sensible starting value when a field is added to a "set fields" action. */
function initialSetValue(field: Field): unknown {
  switch (field.type) {
    case 'user':
      return '@me';
    case 'date':
      return '@today';
    case 'checkbox':
      return true;
    case 'multi_select':
      return [];
    default:
      return '';
  }
}

/**
 * Shared "set these fields to these values" editor, used by both `set_values` and
 * `update_linked`. The field selector comes first; each chosen field then gets a
 * typed value editor below it (MN-230) — never a raw option UUID.
 */
function FieldValuesEditor({
  settable,
  members,
  values,
  addLabel,
  onChange,
}: {
  settable: Field[];
  members: Member[];
  values: Record<string, unknown>;
  addLabel: string;
  onChange: (values: Record<string, unknown>) => void;
}) {
  const remaining = settable.filter((f) => !(f.apiName in values));
  return (
    <div className="flex flex-col gap-1">
      <select
        className="h-7 self-start rounded border border-border-default bg-card px-1 text-[12px] text-muted"
        value=""
        onChange={(e) => {
          const f = settable.find((x) => x.apiName === e.target.value);
          if (!f) return;
          onChange({ ...values, [f.apiName]: initialSetValue(f) });
        }}
      >
        <option value="">{addLabel}</option>
        {remaining.map((f) => (
          <option key={f.id} value={f.apiName}>{f.displayName}</option>
        ))}
      </select>
      {Object.entries(values).map(([key, value]) => {
        const field = settable.find((f) => f.apiName === key);
        return (
          <div key={key} className="flex items-center gap-1.5 text-[12px] text-ink">
            <span className="w-28 shrink-0 truncate text-muted">{field?.displayName ?? key}</span>
            <SetValueEditor field={field} members={members} value={value} onChange={(v) => onChange({ ...values, [key]: v })} />
            <button
              type="button"
              className="p-0.5 text-faint hover:text-error"
              onClick={() => {
                const next = { ...values };
                delete next[key];
                onChange(next);
              }}
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Typed value editor for one "set field" row — mirrors the grid cell editors so a
 * select shows its option labels (while the stored value stays the option id), a
 * user field shows a person picker, dates get a date input, etc. The @me / @today /
 * @now tokens stay reachable on user and date fields.
 */
function SetValueEditor({
  field,
  members,
  value,
  onChange,
}: {
  field: Field | undefined;
  members: Member[];
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const controlCls = 'h-7 min-w-0 flex-1 rounded border border-border-default bg-card px-1 text-[12px] text-ink';
  if (!field) {
    return <Input className="h-7" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />;
  }
  switch (field.type) {
    case 'select':
      return (
        <select className={controlCls} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value || null)}>
          <option value="">— none —</option>
          {(field.options ?? []).map((o) => (
            <option key={o.id} value={o.id}>{o.label}</option>
          ))}
        </select>
      );
    case 'multi_select': {
      const ids = Array.isArray(value) ? (value as string[]) : [];
      const options = field.options ?? [];
      if (options.length === 0) return <span className="flex-1 text-[11px] text-faint">No options</span>;
      return (
        <div className="flex flex-1 flex-wrap items-center gap-1">
          {options.map((o) => {
            const on = ids.includes(o.id);
            return (
              <button
                key={o.id}
                type="button"
                onClick={() => onChange(on ? ids.filter((x) => x !== o.id) : [...ids, o.id])}
                className={cn(
                  'rounded-full border px-2 py-0.5 text-[11px]',
                  on ? 'border-[var(--accent)] bg-active text-ink' : 'border-border-default text-muted',
                )}
              >
                {o.label}
              </button>
            );
          })}
        </div>
      );
    }
    case 'user':
      return (
        <select className={controlCls} value={typeof value === 'string' ? value : '@me'} onChange={(e) => onChange(e.target.value)}>
          <option value="@me">Me (whoever runs it)</option>
          {members.map((m) => (
            <option key={m.id} value={m.id}>{m.name}</option>
          ))}
        </select>
      );
    case 'date':
      return <DateValueEditor value={value} onChange={onChange} />;
    case 'checkbox':
      return (
        <label className="flex flex-1 items-center gap-1.5 text-[12px] text-muted">
          <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
          {value === true ? 'Checked' : 'Unchecked'}
        </label>
      );
    case 'number':
      return (
        <Input
          className="h-7"
          type="number"
          value={value == null ? '' : String(value)}
          onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        />
      );
    default:
      return <Input className="h-7" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />;
  }
}

/** Date value: the @today / @now tokens stay available alongside a concrete date picker. */
function DateValueEditor({ value, onChange }: { value: unknown; onChange: (value: unknown) => void }) {
  const v = typeof value === 'string' ? value : '';
  const isToken = v === '@today' || v === '@now';
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1">
      <select
        className="h-7 rounded border border-border-default bg-card px-1 text-[12px] text-ink"
        value={isToken ? v : 'date'}
        onChange={(e) => {
          const next = e.target.value;
          onChange(next === '@today' || next === '@now' ? next : '');
        }}
      >
        <option value="@today">Today (@today)</option>
        <option value="@now">Now (@now)</option>
        <option value="date">Specific date…</option>
      </select>
      {!isToken && (
        <Input className="h-7 min-w-0 flex-1" type="date" value={v} onChange={(e) => onChange(e.target.value || '')} />
      )}
    </div>
  );
}

/** Relations on the target database that point back at the source. */
function LinkBackPicker({
  ws,
  sourceDb,
  targetDb,
  value,
  onChange,
}: {
  ws: string;
  sourceDb: string;
  targetDb: string;
  value?: string;
  onChange: (v: string | undefined) => void;
}) {
  const target = useDatabase(ws, targetDb);
  const candidates = (target.data?.fields ?? []).filter(
    (f) => f.type === 'relation' && f.relation?.target_database_id === sourceDb,
  );
  if (candidates.length === 0) return null;
  return (
    <select
      className="h-7 rounded border border-border-default bg-card px-1 text-[12px] text-ink"
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value || undefined)}
    >
      <option value="">Don't link back</option>
      {candidates.map((f) => (
        <option key={f.id} value={f.id}>Link back via "{f.displayName}"</option>
      ))}
    </select>
  );
}

/** update_linked action editor: pick a relation, then set fields on the linked (target) records. */
function UpdateLinkedEditor({
  ws,
  relationFields,
  members,
  action,
  onChange,
}: {
  ws: string;
  relationFields: Field[];
  members: Member[];
  action: { type: 'update_linked'; relation_field_id: string; values: Record<string, unknown> };
  onChange: (next: ButtonAction) => void;
}) {
  const relField = relationFields.find((f) => f.id === action.relation_field_id);
  const targetDbId = relField?.relation?.target_database_id ?? '';
  const target = useDatabase(ws, targetDbId);
  const settable = (target.data?.fields ?? []).filter(
    (f) => !f.isSystem && !['title', 'relation', 'lookup', 'rollup', 'button', 'rich_text', 'created_at', 'updated_at', 'created_by'].includes(f.type),
  );
  if (relationFields.length === 0) {
    return <p className="text-[12px] text-faint">This database has no relations to update through.</p>;
  }
  return (
    <div className="flex flex-col gap-1">
      <select
        className="h-7 rounded border border-border-default bg-card px-1 text-[12px] text-ink"
        value={action.relation_field_id}
        onChange={(e) => onChange({ ...action, relation_field_id: e.target.value, values: {} })}
      >
        {relationFields.map((f) => (
          <option key={f.id} value={f.id}>Through "{f.displayName}"</option>
        ))}
      </select>
      <FieldValuesEditor
        settable={settable}
        members={members}
        values={action.values}
        addLabel="＋ field to set on linked…"
        onChange={(values) => onChange({ ...action, values })}
      />
    </div>
  );
}
