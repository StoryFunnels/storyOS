'use client';

import { useState } from 'react';
import { Info, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { api, apiErrorMessage } from '@/lib/api';
import { useDatabases, useHttpConnections } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useDatabase, useMailConnections, useMembers } from './use-table-data';
import type { Field } from './use-table-data';

export type ButtonAction =
  | { type: 'set_values'; values: Record<string, unknown> }
  | {
      type: 'create_record';
      database_id: string;
      values: Record<string, unknown>;
      link_via_relation_field_id?: string;
    }
  | { type: 'add_comment'; body_template: string }
  | { type: 'notify_user'; user: string; message: string }
  | { type: 'update_linked'; relation_field_id: string; values: Record<string, unknown> }
  | { type: 'send_slack_message'; text: string; channel?: string }
  // A secret header value is write-only (#249): reads return the `{ __keep: true }`
  // presence flag in its place, and echoing it back on save keeps the stored value.
  | {
      type: 'send_webhook';
      url: string;
      body_template?: string;
      headers?: Record<string, string | { __keep: true }>;
    }
  // MN-256: `to`/`cc` are comma-separated address templates; `require_approval`
  // left undefined means "default" (gated unless every rendered recipient is
  // an internal workspace member, decided at run time — see actions.service.ts).
  | {
      type: 'send_email';
      connection_id: string;
      to: string;
      cc?: string;
      reply_to?: string;
      subject: string;
      body_markdown: string;
      require_approval?: boolean;
    }
  // MN-263: call any API and (optionally) capture the response back onto
  // fields. `headers` is write-only the same way send_webhook's is (#249).
  | {
      type: 'http_request';
      method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
      url: string;
      headers?: Record<string, string | { __keep: true }>;
      body_template?: string;
      connection_id?: string;
      capture?: { path: string; target_field_id: string }[];
    };

/** MN-254: the only actions a webhook_received rule can run — no triggering record. */
const WEBHOOK_SAFE_ACTIONS = new Set([
  'create_record',
  'send_slack_message',
  'send_webhook',
  'notify_user',
]);

type Member = { id: string; name: string };

/** Compact declarative action builder: set fields / create linked record / comment. */
export function ButtonActionsEditor({
  ws,
  db,
  fields: dbFields,
  actions,
  onChange,
  restrictToWebhookSafe,
  ruleId,
}: {
  ws: string;
  db: string;
  fields: Field[];
  actions: ButtonAction[];
  onChange: (actions: ButtonAction[]) => void;
  /** MN-254: true when the parent rule's trigger is "webhook_received" — there's no
   * triggering record, so only actions that don't need one are offered. */
  restrictToWebhookSafe?: boolean;
  /** MN-263: the saved automation rule's id — enables http_request's "Send test
   * request" (it POSTs .../automations/{ruleId}/test, which needs a saved rule).
   * Undefined for a brand-new unsaved rule, or when editing a button's config
   * (buttons have no test endpoint). */
  ruleId?: string;
}) {
  const databases = useDatabases(ws);
  const mailConnections = useMailConnections(ws);
  const membersQuery = useMembers(ws, true);
  const members = (membersQuery.data ?? []).map((m) => ({ id: m.user.id, name: m.user.name }));
  const settable = dbFields.filter(
    (f) =>
      !f.isSystem &&
      ![
        'title',
        'relation',
        'lookup',
        'rollup',
        'button',
        'rich_text',
        'created_at',
        'updated_at',
        'created_by',
      ].includes(f.type),
  );
  const userFields = dbFields.filter((f) => f.type === 'user');
  const relationFields = dbFields.filter((f) => f.type === 'relation');
  const payloadHint = restrictToWebhookSafe ? ' or {payload.path}' : '';
  /** MN-254: whether to show a given action type in the "Then" dropdown. */
  const offersAction = (type: string) => !restrictToWebhookSafe || WEBHOOK_SAFE_ACTIONS.has(type);

  function patch(i: number, next: ButtonAction) {
    onChange(actions.map((a, j) => (j === i ? next : a)));
  }

  return (
    <div className="flex flex-col gap-2">
      {actions.map((action, i) => (
        <div
          key={i}
          className="flex flex-col gap-1.5 rounded-[var(--radius-card)] border border-border-default p-2"
        >
          <div className="flex items-center gap-2">
            <select
              className="h-8 flex-1 rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-[13px] text-ink"
              value={action.type}
              onChange={(e) => {
                const t = e.target.value;
                if (t === 'set_values') patch(i, { type: 'set_values', values: {} });
                else if (t === 'create_record') {
                  patch(i, {
                    type: 'create_record',
                    database_id: db,
                    values: {
                      name: restrictToWebhookSafe ? '{payload.name}' : 'New record for {Title}',
                    },
                  });
                } else if (t === 'notify_user')
                  patch(i, { type: 'notify_user', user: '@me', message: '' });
                else if (t === 'update_linked')
                  patch(i, {
                    type: 'update_linked',
                    relation_field_id: relationFields[0]?.id ?? '',
                    values: {},
                  });
                else if (t === 'send_webhook') patch(i, { type: 'send_webhook', url: '' });
                else if (t === 'send_slack_message')
                  patch(i, { type: 'send_slack_message', text: '' });
                else if (t === 'send_email')
                  patch(i, {
                    type: 'send_email',
                    connection_id: mailConnections.data?.[0]?.id ?? '',
                    to: '',
                    subject: '',
                    body_markdown: '',
                  });
                else if (t === 'http_request')
                  patch(i, { type: 'http_request', method: 'GET', url: '' });
                else patch(i, { type: 'add_comment', body_template: '' });
              }}
            >
              {/* MN-254: a webhook_received rule has no triggering record, so only
                  WEBHOOK_SAFE_ACTIONS are offered — the backend rejects the rest with
                  a clear 422 either way, but hiding them here avoids a round-trip. */}
              {offersAction('set_values') && (
                <option value="set_values">Set fields on this record</option>
              )}
              <option value="create_record">Create a record</option>
              {offersAction('update_linked') && (
                <option value="update_linked">Update linked records</option>
              )}
              {offersAction('add_comment') && <option value="add_comment">Add a comment</option>}
              <option value="notify_user">Notify a person</option>
              <option value="send_slack_message">Send a Slack message</option>
              <option value="send_webhook">Send a webhook</option>
              {offersAction('send_email') && <option value="send_email">Send an email</option>}
              {offersAction('http_request') && (
                <option value="http_request">Call an API (HTTP request)</option>
              )}
            </select>
            <button
              type="button"
              className="p-1 text-faint hover:text-error"
              onClick={() => onChange(actions.filter((_, j) => j !== i))}
            >
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
                onChange={(e) =>
                  patch(i, {
                    ...action,
                    database_id: e.target.value,
                    link_via_relation_field_id: undefined,
                  })
                }
              >
                {(databases.data ?? []).map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
              <Input
                className="h-7"
                placeholder={`Title template — {Title} inserts this record's title${payloadHint}`}
                value={String(action.values.name ?? '')}
                onChange={(e) =>
                  patch(i, { ...action, values: { ...action.values, name: e.target.value } })
                }
              />
              {!restrictToWebhookSafe && (
                <LinkBackPicker
                  ws={ws}
                  sourceDb={db}
                  targetDb={action.database_id}
                  value={action.link_via_relation_field_id}
                  onChange={(v) => patch(i, { ...action, link_via_relation_field_id: v })}
                />
              )}
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

          {action.type === 'send_slack_message' && (
            <div className="flex flex-col gap-1">
              <Input
                className="h-7"
                placeholder="#channel or channel id (optional — falls back to the workspace default)"
                value={action.channel ?? ''}
                onChange={(e) => patch(i, { ...action, channel: e.target.value || undefined })}
              />
              <textarea
                className="min-h-[56px] rounded border border-border-default bg-card px-2 py-1 text-[12px] text-ink"
                placeholder={`Message${payloadHint ? ' — {payload.path} interpolates values' : ' — {Field Name} interpolates values'}`}
                value={action.text}
                onChange={(e) => patch(i, { ...action, text: e.target.value })}
              />
            </div>
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
                placeholder={`https://hooks.example.com/... — {Field Name} interpolates${payloadHint}`}
                value={action.url}
                onChange={(e) => patch(i, { ...action, url: e.target.value })}
              />
              <textarea
                className="min-h-[56px] rounded border border-border-default bg-card px-2 py-1 font-mono text-[12px] text-ink"
                placeholder={`Body (optional) — JSON is sent as-is, {Field Name} interpolates${payloadHint}.\nLeave empty to send the whole record.`}
                value={action.body_template ?? ''}
                onChange={(e) =>
                  patch(i, { ...action, body_template: e.target.value || undefined })
                }
              />
              <p className="text-[11px] text-faint">
                Signed with the workspace webhook secret; failures retry automatically.
              </p>
            </div>
          )}

          {action.type === 'send_email' && (
            <SendEmailEditor
              ws={ws}
              connections={mailConnections.data ?? []}
              action={action}
              onChange={(next) => patch(i, next)}
            />
          )}

          {action.type === 'http_request' && (
            <HttpRequestEditor
              ws={ws}
              db={db}
              settable={settable}
              action={action}
              ruleId={ruleId}
              actionIndex={i}
              payloadHint={payloadHint}
              onChange={(next) => patch(i, next)}
            />
          )}

          {action.type === 'notify_user' && (
            <div className="flex flex-col gap-1">
              <select
                className="h-7 rounded border border-border-default bg-card px-1 text-[12px] text-ink"
                value={action.user}
                onChange={(e) => patch(i, { ...action, user: e.target.value })}
              >
                <option value="@me">Me (whoever runs it)</option>
                {/* MN-254: a webhook rule has no triggering record, so a person FIELD
                    can't be read — only "@me" (the rule owner) is valid there. */}
                {!restrictToWebhookSafe &&
                  userFields.map((f) => (
                    <option key={f.id} value={f.apiName}>
                      {f.displayName}
                    </option>
                  ))}
              </select>
              <Input
                className="h-7"
                placeholder={`Message — {Field Name} interpolates values${payloadHint}`}
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
          <option key={f.id} value={f.apiName}>
            {f.displayName}
          </option>
        ))}
      </select>
      {Object.entries(values).map(([key, value]) => {
        const field = settable.find((f) => f.apiName === key);
        return (
          <div key={key} className="flex items-center gap-1.5 text-[12px] text-ink">
            <span className="w-28 shrink-0 truncate text-muted">{field?.displayName ?? key}</span>
            <SetValueEditor
              field={field}
              members={members}
              value={value}
              onChange={(v) => onChange({ ...values, [key]: v })}
            />
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
  const controlCls =
    'h-7 min-w-0 flex-1 rounded border border-border-default bg-card px-1 text-[12px] text-ink';
  if (!field) {
    return (
      <Input
        className="h-7"
        value={String(value ?? '')}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  switch (field.type) {
    case 'select':
      return (
        <select
          className={controlCls}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value || null)}
        >
          <option value="">— none —</option>
          {(field.options ?? []).map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      );
    case 'multi_select': {
      const ids = Array.isArray(value) ? (value as string[]) : [];
      const options = field.options ?? [];
      if (options.length === 0)
        return <span className="flex-1 text-[11px] text-faint">No options</span>;
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
                  on
                    ? 'border-[var(--accent)] bg-active text-ink'
                    : 'border-border-default text-muted',
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
        <select
          className={controlCls}
          value={typeof value === 'string' ? value : '@me'}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="@me">Me (whoever runs it)</option>
          {members.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      );
    case 'date':
      return <DateValueEditor value={value} onChange={onChange} />;
    case 'checkbox':
      return (
        <label className="flex flex-1 items-center gap-1.5 text-[12px] text-muted">
          <input
            type="checkbox"
            checked={value === true}
            onChange={(e) => onChange(e.target.checked)}
          />
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
      return (
        <Input
          className="h-7"
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
}

/** Date value: the @today / @now tokens stay available alongside a concrete date picker. */
function DateValueEditor({
  value,
  onChange,
}: {
  value: unknown;
  onChange: (value: unknown) => void;
}) {
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
        <Input
          className="h-7 min-w-0 flex-1"
          type="date"
          value={v}
          onChange={(e) => onChange(e.target.value || '')}
        />
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
        <option key={f.id} value={f.id}>
          Link back via "{f.displayName}"
        </option>
      ))}
    </select>
  );
}

/**
 * send_email action editor (MN-256). Approval badge: shows "Default" (gated
 * unless every rendered recipient turns out to be an internal member, decided
 * at run time — the backend's own call, not this UI's), or the two explicit
 * overrides. Turning approval fully off is admin-only server-side
 * (actions.service.ts's validate()) — enforced there, not hidden here, since
 * the wrong role finding out via a clear save-time error is fine.
 */
function SendEmailEditor({
  ws,
  connections,
  action,
  onChange,
}: {
  ws: string;
  connections: Array<{ id: string; name: string; provider: string; status: string }>;
  action: Extract<ButtonAction, { type: 'send_email' }>;
  onChange: (next: ButtonAction) => void;
}) {
  const approvalValue = action.require_approval === undefined ? 'default' : action.require_approval ? 'always' : 'never';
  return (
    <div className="flex flex-col gap-1.5">
      {connections.length === 0 && (
        <div className="flex items-start gap-1.5 rounded border border-border-default bg-hover px-2 py-1.5 text-[11px] text-muted">
          <Info className="mt-0.5 h-3 w-3 shrink-0" />
          <span>
            No Resend/SMTP connection yet.{' '}
            <Link
              href={`/w/${ws}/settings/connections`}
              target="_blank"
              className="underline underline-offset-2 hover:no-underline"
            >
              Connect one
            </Link>
            {' '}first — it needs a from-address before it can be used here.
          </span>
        </div>
      )}
      <select
        className="h-7 rounded border border-border-default bg-card px-1 text-[12px] text-ink"
        value={action.connection_id}
        onChange={(e) => onChange({ ...action, connection_id: e.target.value })}
      >
        <option value="">Choose a connection…</option>
        {connections.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name} ({c.provider}){c.status !== 'active' ? ` — ${c.status}` : ''}
          </option>
        ))}
      </select>
      <Input
        className="h-7"
        placeholder="To — comma-separated, {Field Name} interpolates"
        value={action.to}
        onChange={(e) => onChange({ ...action, to: e.target.value })}
      />
      <Input
        className="h-7"
        placeholder="Cc (optional)"
        value={action.cc ?? ''}
        onChange={(e) => onChange({ ...action, cc: e.target.value || undefined })}
      />
      <Input
        className="h-7"
        placeholder="Reply-To (optional)"
        value={action.reply_to ?? ''}
        onChange={(e) => onChange({ ...action, reply_to: e.target.value || undefined })}
      />
      <Input
        className="h-7"
        placeholder="Subject — {Field Name} interpolates"
        value={action.subject}
        onChange={(e) => onChange({ ...action, subject: e.target.value })}
      />
      <textarea
        className="min-h-[80px] rounded border border-border-default bg-card px-2 py-1 text-[12px] text-ink"
        placeholder="Body (markdown) — {Field Name} interpolates values"
        value={action.body_markdown}
        onChange={(e) => onChange({ ...action, body_markdown: e.target.value })}
      />
      <div className="flex items-center gap-1.5 text-[11px] text-muted">
        <ShieldCheck className="h-3 w-3 shrink-0" />
        <span>Approval:</span>
        <select
          className="h-6 rounded border border-border-default bg-card px-1 text-[11px] text-ink"
          value={approvalValue}
          onChange={(e) => {
            const v = e.target.value;
            onChange({
              ...action,
              require_approval: v === 'default' ? undefined : v === 'always',
            });
          }}
        >
          <option value="default">Default (gated unless all-internal at send time)</option>
          <option value="always">Always require approval</option>
          <option value="never">Never (admin-only setting)</option>
        </select>
      </div>
    </div>
  );
}

type HttpRequestAction = Extract<ButtonAction, { type: 'http_request' }>;

/**
 * MN-263 — the http_request action editor: method/url/headers/body, an
 * optional 'http' connection for auth, response-capture rows, and "Send test
 * request" (a REAL network call — only offered once the rule is saved, since
 * it hits .../automations/{ruleId}/test).
 */
function HttpRequestEditor({
  ws,
  db,
  settable,
  action,
  ruleId,
  actionIndex,
  payloadHint,
  onChange,
}: {
  ws: string;
  db: string;
  settable: Field[];
  action: HttpRequestAction;
  ruleId?: string;
  actionIndex: number;
  payloadHint: string;
  onChange: (next: HttpRequestAction) => void;
}) {
  const connections = useHttpConnections(ws);
  const headers = action.headers ?? {};
  const capture = action.capture ?? [];

  function setHeader(name: string, value: string) {
    onChange({ ...action, headers: { ...headers, [name]: value } });
  }
  function removeHeader(name: string) {
    const next = { ...headers };
    delete next[name];
    onChange({ ...action, headers: next });
  }
  function addHeader() {
    let name = 'X-Header';
    let n = 2;
    while (name in headers) name = `X-Header-${n++}`;
    onChange({ ...action, headers: { ...headers, [name]: '' } });
  }
  function renameHeader(oldName: string, newName: string) {
    if (!newName || newName === oldName || newName in headers) return;
    const next: typeof headers = {};
    for (const [k, v] of Object.entries(headers)) next[k === oldName ? newName : k] = v;
    onChange({ ...action, headers: next });
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex gap-1.5">
        <select
          className="h-7 w-24 shrink-0 rounded border border-border-default bg-card px-1 text-[12px] text-ink"
          value={action.method}
          onChange={(e) => onChange({ ...action, method: e.target.value as HttpRequestAction['method'] })}
        >
          {(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const).map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <Input
          className="h-7 flex-1"
          type="url"
          placeholder={`https://api.example.com/... — {Field Name} interpolates${payloadHint}`}
          value={action.url}
          onChange={(e) => onChange({ ...action, url: e.target.value })}
        />
      </div>

      <div className="flex flex-col gap-1 rounded border border-border-default p-1.5">
        <p className="text-[11px] font-medium text-muted">Headers</p>
        {Object.entries(headers).map(([name, value]) => {
          const isSecret = typeof value !== 'string'; // { __keep: true }
          return (
            <div key={name} className="flex items-center gap-1">
              <Input
                className="h-6 w-32 shrink-0 text-[11px]"
                value={name}
                onChange={(e) => renameHeader(name, e.target.value)}
              />
              <Input
                className="h-6 flex-1 text-[11px]"
                type={isSecret ? 'password' : 'text'}
                placeholder={isSecret ? '(unchanged — type to replace)' : ''}
                value={isSecret ? '' : value}
                onChange={(e) => setHeader(name, e.target.value)}
              />
              <button type="button" className="p-0.5 text-faint hover:text-error" onClick={() => removeHeader(name)}>
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          );
        })}
        <button
          type="button"
          className="flex items-center gap-1 self-start text-[11px] text-muted hover:text-ink"
          onClick={addHeader}
        >
          <Plus className="h-3 w-3" /> Add header
        </button>
      </div>

      {action.method !== 'GET' && (
        <textarea
          className="min-h-[56px] rounded border border-border-default bg-card px-2 py-1 font-mono text-[12px] text-ink"
          placeholder={`Body (optional) — JSON is sent as-is, {Field Name} interpolates${payloadHint}`}
          value={action.body_template ?? ''}
          onChange={(e) => onChange({ ...action, body_template: e.target.value || undefined })}
        />
      )}

      <div className="flex flex-col gap-1">
        <label className="text-[11px] font-medium text-muted">Auth (optional)</label>
        <select
          className="h-7 rounded border border-border-default bg-card px-1 text-[12px] text-ink"
          value={action.connection_id ?? ''}
          onChange={(e) => onChange({ ...action, connection_id: e.target.value || undefined })}
        >
          <option value="">No auth</option>
          {(connections.data ?? []).map((c: { id: string; name: string }) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        {(connections.data ?? []).length === 0 && (
          <p className="text-[11px] text-faint">
            No HTTP connections yet —{' '}
            <Link href={`/w/${ws}/settings/connections`} target="_blank" className="underline underline-offset-2 hover:no-underline">
              add one
            </Link>{' '}
            to send an Authorization header without typing it here.
          </p>
        )}
      </div>

      <CaptureRowsEditor
        settable={settable}
        capture={capture}
        onChange={(next) => onChange({ ...action, capture: next })}
      />

      <p className="text-[11px] text-faint">
        Response captured via json-path (e.g. <code>id</code> or <code>items.0.id</code>) onto the
        fields above. Secrets from the connection are never shown in run results.
      </p>

      {ruleId && <SendTestRequestButton ws={ws} db={db} ruleId={ruleId} actionIndex={actionIndex} />}
    </div>
  );
}

/** MN-263 — response-capture rows: a json-path plus the field it lands on. */
function CaptureRowsEditor({
  settable,
  capture,
  onChange,
}: {
  settable: Field[];
  capture: { path: string; target_field_id: string }[];
  onChange: (next: { path: string; target_field_id: string }[]) => void;
}) {
  return (
    <div className="flex flex-col gap-1 rounded border border-border-default p-1.5">
      <p className="text-[11px] font-medium text-muted">Capture response into fields</p>
      {capture.map((row, i) => (
        <div key={i} className="flex items-center gap-1">
          <Input
            className="h-6 w-32 shrink-0 font-mono text-[11px]"
            placeholder="json path, e.g. id"
            value={row.path}
            onChange={(e) =>
              onChange(capture.map((r, j) => (j === i ? { ...r, path: e.target.value } : r)))
            }
          />
          <span className="text-[11px] text-faint">→</span>
          <select
            className="h-6 flex-1 rounded border border-border-default bg-card px-1 text-[11px] text-ink"
            value={row.target_field_id}
            onChange={(e) =>
              onChange(capture.map((r, j) => (j === i ? { ...r, target_field_id: e.target.value } : r)))
            }
          >
            <option value="">field…</option>
            {settable.map((f) => (
              <option key={f.id} value={f.id}>
                {f.displayName}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="p-0.5 text-faint hover:text-error"
            onClick={() => onChange(capture.filter((_, j) => j !== i))}
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      ))}
      {capture.length < 10 && (
        <button
          type="button"
          className="flex items-center gap-1 self-start text-[11px] text-muted hover:text-ink"
          onClick={() => onChange([...capture, { path: '', target_field_id: settable[0]?.id ?? '' }])}
        >
          <Plus className="h-3 w-3" /> Add capture
        </button>
      )}
    </div>
  );
}

/**
 * MN-263 — "Send test request": a real network call against a sample record,
 * via .../automations/{ruleId}/test with { record_id, action_index }. Confirms
 * with the user first since this is not a dry run.
 */
function SendTestRequestButton({
  ws,
  db,
  ruleId,
  actionIndex,
}: {
  ws: string;
  db: string;
  ruleId: string;
  actionIndex: number;
}) {
  const [recordRef, setRecordRef] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ status: number; body: string; available_paths: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    if (!recordRef.trim()) return;
    if (!window.confirm('This sends a REAL request to the URL above, right now. Continue?')) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const { data, error: err } = await api.POST(
        '/api/v1/workspaces/{ws}/databases/{db}/automations/{id}/test',
        {
          params: { path: { ws, db, id: ruleId } },
          body: { record_id: recordRef.trim(), action_index: actionIndex } as never,
        } as never,
      );
      if (err) throw err;
      setResult(data as unknown as { status: number; body: string; available_paths: string[] });
    } catch (e) {
      setError(apiErrorMessage(e, 'Test request failed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-1.5 rounded border border-border-default p-1.5">
      <p className="text-[11px] font-medium text-muted">Send test request</p>
      <div className="flex items-center gap-1.5">
        <Input
          className="h-7 flex-1"
          placeholder="Record id to test against (from its URL)"
          value={recordRef}
          onChange={(e) => setRecordRef(e.target.value)}
        />
        <Button variant="secondary" size="sm" disabled={busy || !recordRef.trim()} onClick={send}>
          {busy ? 'Sending…' : 'Send test request'}
        </Button>
      </div>
      {error && <p className="text-[11px] text-error">{error}</p>}
      {result && (
        <div className="flex flex-col gap-1">
          <p className="text-[11px] text-muted">
            HTTP {result.status} {result.status >= 200 && result.status < 300 ? '✓' : ''}
          </p>
          <pre className="max-h-32 overflow-auto rounded bg-card p-1.5 text-[11px] text-ink">
            {result.body}
          </pre>
        </div>
      )}
    </div>
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
    (f) =>
      !f.isSystem &&
      ![
        'title',
        'relation',
        'lookup',
        'rollup',
        'button',
        'rich_text',
        'created_at',
        'updated_at',
        'created_by',
      ].includes(f.type),
  );
  if (relationFields.length === 0) {
    return (
      <p className="text-[12px] text-faint">This database has no relations to update through.</p>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <select
        className="h-7 rounded border border-border-default bg-card px-1 text-[12px] text-ink"
        value={action.relation_field_id}
        onChange={(e) => onChange({ ...action, relation_field_id: e.target.value, values: {} })}
      >
        {relationFields.map((f) => (
          <option key={f.id} value={f.id}>
            Through "{f.displayName}"
          </option>
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
