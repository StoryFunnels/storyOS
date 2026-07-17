'use client';

import { Plus, Trash2 } from 'lucide-react';
import { useDatabases } from '@/lib/queries';
import { Input } from '@/components/ui/input';
import { useDatabase } from './use-table-data';
import type { Field } from './use-table-data';

export type ButtonAction =
  | { type: 'set_values'; values: Record<string, unknown> }
  | { type: 'create_record'; database_id: string; values: Record<string, unknown>; link_via_relation_field_id?: string }
  | { type: 'add_comment'; body_template: string }
  | { type: 'notify_user'; user: string; message: string }
  | { type: 'update_linked'; relation_field_id: string; values: Record<string, unknown> }
  | { type: 'send_webhook'; url: string; body_template?: string; headers?: Record<string, string> };

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
            <div className="flex flex-col gap-1">
              {Object.entries(action.values).map(([key, value]) => (
                <div key={key} className="flex items-center gap-1.5 text-[12px] text-ink">
                  <span className="w-28 truncate text-muted">{settable.find((f) => f.apiName === key)?.displayName ?? key}</span>
                  <Input
                    className="h-7"
                    value={String(value ?? '')}
                    onChange={(e) => patch(i, { ...action, values: { ...action.values, [key]: coerceActionValue(settable.find((f) => f.apiName === key), e.target.value) } })}
                  />
                  <button type="button" className="p-0.5 text-faint hover:text-error" onClick={() => {
                    const next = { ...action.values };
                    delete next[key];
                    patch(i, { ...action, values: next });
                  }}>
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              ))}
              <select
                className="h-7 self-start rounded border border-border-default bg-card px-1 text-[12px] text-muted"
                value=""
                onChange={(e) => {
                  const f = settable.find((x) => x.apiName === e.target.value);
                  if (!f) return;
                  const initial = f.type === 'user' ? '@me' : f.type === 'date' ? '@today' : f.type === 'checkbox' ? true : '';
                  patch(i, { ...action, values: { ...action.values, [f.apiName]: initial } });
                }}
              >
                <option value="">＋ field to set…</option>
                {settable.filter((f) => !(f.apiName in action.values)).map((f) => (
                  <option key={f.id} value={f.apiName}>{f.displayName}</option>
                ))}
              </select>
              <p className="text-[11px] text-faint">Tokens: @me · @today · @now. Selects take the option id or label via the API.</p>
            </div>
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

function coerceActionValue(field: Field | undefined, raw: string): unknown {
  if (!field) return raw;
  if (field.type === 'number') return raw === '' ? null : Number(raw);
  if (field.type === 'checkbox') return raw === 'true';
  if (field.type === 'select') {
    return field.options?.find((o) => o.label === raw)?.id ?? raw;
  }
  return raw;
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
  action,
  onChange,
}: {
  ws: string;
  relationFields: Field[];
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
      {Object.entries(action.values).map(([key, value]) => (
        <div key={key} className="flex items-center gap-1.5 text-[12px] text-ink">
          <span className="w-28 truncate text-muted">{settable.find((f) => f.apiName === key)?.displayName ?? key}</span>
          <Input
            className="h-7"
            value={String(value ?? '')}
            onChange={(e) => onChange({ ...action, values: { ...action.values, [key]: coerceActionValue(settable.find((f) => f.apiName === key), e.target.value) } })}
          />
          <button
            type="button"
            className="p-0.5 text-faint hover:text-error"
            onClick={() => {
              const next = { ...action.values };
              delete next[key];
              onChange({ ...action, values: next });
            }}
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      ))}
      <select
        className="h-7 self-start rounded border border-border-default bg-card px-1 text-[12px] text-muted"
        value=""
        onChange={(e) => {
          const f = settable.find((x) => x.apiName === e.target.value);
          if (!f) return;
          const initial = f.type === 'user' ? '@me' : f.type === 'date' ? '@today' : f.type === 'checkbox' ? true : '';
          onChange({ ...action, values: { ...action.values, [f.apiName]: initial } });
        }}
      >
        <option value="">＋ field to set on linked…</option>
        {settable.filter((f) => !(f.apiName in action.values)).map((f) => (
          <option key={f.id} value={f.apiName}>{f.displayName}</option>
        ))}
      </select>
    </div>
  );
}
