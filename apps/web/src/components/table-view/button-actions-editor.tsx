'use client';

import { useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { Check, Info, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { api, apiErrorMessage } from '@/lib/api';
import { useDatabases, useHttpConnections } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Select } from '@/components/ui/select';
import { EntityPickerRow } from '@/components/entity/entity-picker-row';
import { DbColorMarker, type LinkChip } from './relation-cell';
import { useDatabase, useMailConnections, useMembers } from './use-table-data';
import { opsForField } from '@/components/views/view-toolbar';
import type { Field } from './use-table-data';

/**
 * #274 — an optional per-action condition (#245's backend): this action runs only
 * when the filter matches the triggering record; a non-match skips just this
 * action (the run log records it as skipped) and later actions still run. One
 * flat clause is enough here and is itself a valid FilterNode server-side.
 */
export type ActionCondition = { field: string; op: string; value?: unknown };

export type ButtonAction = ({ condition?: ActionCondition } & (
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
    }
));

/** MN-254: the only actions a webhook_received rule can run — no triggering record. */
const WEBHOOK_SAFE_ACTIONS = new Set([
  'create_record',
  'send_slack_message',
  'send_webhook',
  'notify_user',
]);

/** #285 — the "Then" type-select's option list, extracted so the flow-diagram
 * canvas's own "add action" control offers exactly the same set, grouped the
 * same way (#152's Common/Advanced split), rather than a second hand-kept
 * list that drifts from this one (#375/#380/#383/#399/#408/#422's shape). */
export const ACTION_TYPE_GROUPS: Array<{ label: string; options: Array<{ value: string; label: string }> }> = [
  {
    label: 'Common',
    options: [
      { value: 'set_values', label: 'Set fields on this record' },
      { value: 'create_record', label: 'Create a record' },
      { value: 'update_linked', label: 'Update linked records' },
      { value: 'add_comment', label: 'Add a comment' },
      { value: 'notify_user', label: 'Notify a person' },
      { value: 'send_slack_message', label: 'Send a Slack message' },
      { value: 'send_email', label: 'Send an email' },
    ],
  },
  {
    label: 'Advanced · developer',
    options: [
      { value: 'send_webhook', label: 'Send a webhook' },
      { value: 'http_request', label: 'Call an API (HTTP request)' },
    ],
  },
];

/** #285 — one place building a fresh action's starting shape for a given
 * type, shared by the "Then" list's type-select (changing an existing
 * action's type) and the flow-diagram canvas's "add action" control
 * (appending a new one) — the same reasoning `ACTION_TYPE_GROUPS` above is
 * extracted for, applied to the OTHER half of the same switch. */
export function defaultActionFor(
  type: string,
  ctx: { db: string; relationFields: Field[]; mailConnectionId?: string; restrictToWebhookSafe?: boolean },
): ButtonAction {
  if (type === 'set_values') return { type: 'set_values', values: {} };
  if (type === 'create_record') {
    return {
      type: 'create_record',
      database_id: ctx.db,
      values: { name: ctx.restrictToWebhookSafe ? '{payload.name}' : 'New record for {Title}' },
    };
  }
  if (type === 'notify_user') return { type: 'notify_user', user: '@me', message: '' };
  if (type === 'update_linked') {
    return { type: 'update_linked', relation_field_id: ctx.relationFields[0]?.id ?? '', values: {} };
  }
  if (type === 'send_webhook') return { type: 'send_webhook', url: '' };
  if (type === 'send_slack_message') return { type: 'send_slack_message', text: '' };
  if (type === 'send_email') {
    return {
      type: 'send_email',
      connection_id: ctx.mailConnectionId ?? '',
      to: '',
      subject: '',
      body_markdown: '',
    };
  }
  if (type === 'http_request') return { type: 'http_request', method: 'GET', url: '' };
  return { type: 'add_comment', body_template: '' };
}

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
  // #729 — kept restrictive: the http_request capture-response editor below
  // writes a raw captured scalar straight onto `target_field_id` with no typed
  // value control at all (see CaptureRowsEditor), so a relation field (which
  // needs an array of target ids, not a bare captured string) or a title stay
  // out of THIS list. `settableForSet` below is the relaxed one for actually
  // building a typed value through FieldValuesEditor.
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
  const settableForSet = settableFieldsForSetValues(dbFields);
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
            <Select
              size="sm"
              className="flex-1"
              value={action.type}
              onChange={(e) =>
                patch(
                  i,
                  defaultActionFor(e.target.value, {
                    db,
                    relationFields,
                    mailConnectionId: mailConnections.data?.[0]?.id,
                    restrictToWebhookSafe,
                  }),
                )
              }
            >
              {/* MN-254: a webhook_received rule has no triggering record, so only
                  WEBHOOK_SAFE_ACTIONS are offered — the backend rejects the rest with
                  a clear 422 either way, but hiding them here avoids a round-trip. */}
              {/* #152 — the everyday actions come first; the two that are really
                  API-integration developer tooling (raw webhooks, arbitrary HTTP
                  with headers/json-path) sit in their own group so a
                  non-technical user isn't offered them as peers of "Add a
                  comment". Same options, honestly labelled. #285 — the group/option
                  list itself now lives in ACTION_TYPE_GROUPS, shared with the flow
                  diagram canvas's own "add action" control. */}
              {ACTION_TYPE_GROUPS.map((group) => (
                <optgroup key={group.label} label={group.label}>
                  {group.options
                    .filter((o) => offersAction(o.value))
                    .map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                </optgroup>
              ))}
            </Select>
            {/* #706 — the four delete buttons in this file KEEP faint: each
                contains only a Trash2 icon, a non-text graphic judged at 3:1,
                which faint clears. They also darken to text-error on hover. */}
            <button
              type="button"
              className="p-1 text-faint hover:text-error"
              onClick={() => onChange(actions.filter((_, j) => j !== i))}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>

          {/* #274 — the per-action "Only if…" gate (#245's backend). Hidden for a
              webhook_received rule: it has no triggering record, so the server
              can't evaluate a record filter and would just run the action anyway
              — offering the control there would be a lie. */}
          {!restrictToWebhookSafe && (
          <ActionConditionRow
            fields={dbFields}
            condition={action.condition}
            onChange={(condition) => patch(i, { ...action, condition })}
          />
          )}

          {action.type === 'set_values' && (
            <FieldValuesEditor
              ws={ws}
              settable={settableForSet}
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
              <Textarea
                size="sm"
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
              <p className="text-[11px] text-muted">
                Sends the whole record, signed with the workspace webhook secret; failures
                retry automatically.
              </p>
              {/* #152 — a hand-written JSON body is developer tooling: the default
                  (send the whole record) is what most people want. */}
              <AdvancedDetails label="Custom JSON body">
                <Textarea
                  size="sm"
                  className="w-full font-mono"
                  placeholder={`JSON is sent as-is, {Field Name} interpolates${payloadHint}.\nLeave empty to send the whole record.`}
                  value={action.body_template ?? ''}
                  onChange={(e) =>
                    patch(i, { ...action, body_template: e.target.value || undefined })
                  }
                />
              </AdvancedDetails>
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
        onClick={() => onChange([...actions, defaultActionFor('add_comment', { db, relationFields })])}
      >
        <Plus className="h-3.5 w-3.5" /> Add action
      </button>
    </div>
  );
}

/** Sensible starting value when a field is added to a "set fields" action. */
export function initialSetValue(field: Field): unknown {
  switch (field.type) {
    case 'user':
      return '@me';
    case 'date':
      return '@today';
    case 'checkbox':
      return true;
    case 'multi_select':
    case 'relation':
      return [];
    default:
      return '';
  }
}

/**
 * #729 — the field types an automation can SET a value on, shared by both
 * `set_values` and `update_linked`. The backend (actions.service.ts) validates
 * only that the key names a known field, nothing about its type, so this list
 * exists purely to keep out field types with no meaningful "set" (computed
 * lookup/rollup, system timestamps/actor, a button) or that need a value
 * control this editor doesn't build (rich_text). `title` and `relation` used
 * to be excluded too — over-broad: the API already accepts both, and
 * SetValueEditor now has a real control for each (a plain text input for
 * title, RelationSetValuePicker for relation).
 */
export function settableFieldsForSetValues(fields: Field[]): Field[] {
  return fields.filter(
    (f) =>
      !f.isSystem &&
      !['lookup', 'rollup', 'button', 'rich_text', 'created_at', 'updated_at', 'created_by'].includes(
        f.type,
      ),
  );
}

/**
 * Shared "set these fields to these values" editor, used by both `set_values` and
 * `update_linked`. The field selector comes first; each chosen field then gets a
 * typed value editor below it (MN-230) — never a raw option UUID. `ws` is only
 * used by the relation case's record picker.
 */
function FieldValuesEditor({
  ws,
  settable,
  members,
  values,
  addLabel,
  onChange,
}: {
  ws: string;
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
              ws={ws}
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
  ws,
  field,
  members,
  value,
  onChange,
}: {
  ws: string;
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
        return <span className="flex-1 text-[11px] text-muted">No options</span>;
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
    case 'relation':
      return field.relation ? (
        <RelationSetValuePicker
          ws={ws}
          field={field}
          value={value}
          onChange={onChange}
        />
      ) : (
        <span className="flex-1 text-[11px] text-muted">Relation config missing</span>
      );
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

/**
 * #729 (AC2) — record picker for a relation "set field" value. Deliberately
 * NOT RelationEditor (relation-cell.tsx): that component PUTs to a specific
 * record's live links on every click, because it edits an actual cell. Here
 * there is no record yet — this is automation CONFIG, a value that only gets
 * applied whenever the automation later runs — so picking just updates local
 * state via `onChange`, the same contract every other SetValueEditor case
 * already has. Reuses the parts that aren't tied to a live write: the same
 * record-picker search endpoint/query key RelationEditor uses, EntityPickerRow
 * (#169) for result rows, and DbColorMarker for the target database's chip.
 * Stored value is always `string[]` of record ids — the shape
 * `RecordsService.planLinks` already accepts for every relation cardinality
 * (single-valued sides just carry one element).
 */
function RelationSetValuePicker({
  ws,
  field,
  value,
  onChange,
}: {
  ws: string;
  field: Field;
  value: unknown;
  onChange: (value: string[]) => void;
}) {
  const relation = field.relation!;
  const single = relation.cardinality === 'one_to_many' && relation.side === 'a';
  const targetDb = relation.target_database_id;
  const ids = Array.isArray(value) ? (value as unknown[]).map((v) => String(v)) : [];

  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  const results = useQuery({
    queryKey: ['record-picker', ws, targetDb, search],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/databases/{db}/records', {
        params: { path: { ws, db: targetDb }, query: { q: search || undefined, limit: 20 } },
      });
      if (error) throw error;
      return (data as unknown as { data: LinkChip[] }).data;
    },
    enabled: open,
  });

  // Resolves titles for already-picked ids that aren't in the current search
  // results (e.g. reopening a saved automation) — one GET per id, the same
  // per-id-resolve shape `useWorkspaceFields` (agent-ref-cell.tsx) uses for a
  // flat list of refs with no batch-lookup endpoint.
  const resolved = useQueries({
    queries: ids.map((id) => ({
      queryKey: ['record-picker-resolve', ws, targetDb, id],
      queryFn: async () => {
        const { data, error } = await api.GET(
          '/api/v1/workspaces/{ws}/databases/{db}/records/{rec}',
          { params: { path: { ws, db: targetDb, rec: id } } },
        );
        if (error) throw error;
        return data as unknown as LinkChip;
      },
      staleTime: 60_000,
    })),
  });
  const byId = new Map<string, LinkChip>();
  for (const row of results.data ?? []) byId.set(row.id, row);
  for (const r of resolved) if (r.data) byId.set(r.data.id, r.data);
  const chips: LinkChip[] = ids.map((id) => byId.get(id) ?? { id, title: '…' });

  function toggle(row: LinkChip) {
    if (single) {
      onChange([row.id]);
      setOpen(false);
      setSearch('');
      return;
    }
    onChange(ids.includes(row.id) ? ids.filter((x) => x !== row.id) : [...ids, row.id]);
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-7 min-w-0 flex-1 flex-wrap items-center gap-1 truncate rounded border border-border-default bg-card px-1.5 text-left text-[12px] text-ink"
      >
        {chips.length === 0 ? (
          <span className="text-muted">Choose {relation.target_database_name ?? 'record'}…</span>
        ) : (
          chips.map((chip) => (
            <span key={chip.id} className="flex items-center gap-1 truncate">
              <DbColorMarker color={relation.target_database_color} />
              <span className="truncate">{chip.title || 'Untitled'}</span>
            </span>
          ))
        )}
      </button>
      {/*
       * #729 — a `Popover` here (this file's other pickers' pattern) silently
       * never receives clicks: this editor is itself rendered inside the
       * "Buttons & automations" modal Dialog, and Radix's modal Dialog sets
       * `body { pointer-events: none }` while open, re-enabling only its own
       * content branch. A Popover's portal is a plain sibling of that branch,
       * not part of it, so every click on it passed straight through to
       * whatever the dialog rendered underneath — confirmed live (the click
       * landed on the dialog's own Cancel/Save row, not the picker). A nested
       * `<Dialog>` doesn't have this problem: this codebase already nests one
       * modal Dialog inside another for the same reason (record-history.tsx's
       * restore-confirmation dialog over its own History dialog), and Radix
       * Dialogs coordinate their pointer-events locks with each other
       * correctly where a Dialog-inside-Popover-inside-Dialog chain does not.
       */}
      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) setSearch('');
        }}
      >
        {open && (
          <DialogContent
            title={`Choose ${relation.target_database_name ?? 'record'}`}
            className="max-w-sm"
          >
            <input
              autoFocus
              placeholder={`Search ${relation.target_database_name ?? 'records'}…`}
              className="mb-2 w-full rounded border border-border-default bg-card px-2 py-1.5 text-[12px] text-ink outline-none placeholder:text-muted"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <div className="max-h-56 overflow-y-auto">
              {(results.data ?? []).map((row) => (
                <EntityPickerRow
                  key={row.id}
                  icon={<DbColorMarker color={relation.target_database_color} />}
                  title={row.title || 'Untitled'}
                  idChip={row.number ?? null}
                  onClick={() => toggle(row)}
                  trailing={
                    ids.includes(row.id) ? (
                      <Check className="h-3.5 w-3.5 text-accent" />
                    ) : undefined
                  }
                />
              ))}
              {results.data?.length === 0 && (
                // PR #845 review: text-muted, not text-faint — this empty-state
                // message is the only content shown at that moment and tells
                // the user their search found nothing, not decoration.
                <p className="px-2 py-1.5 text-[11px] text-muted">No matches</p>
              )}
            </div>
            <div className="mt-2 flex justify-between border-t border-border-default pt-2">
              {!single && ids.length > 0 ? (
                <button
                  type="button"
                  className="text-[12px] text-muted hover:text-ink"
                  onClick={() => onChange([])}
                >
                  Clear
                </button>
              ) : (
                <span />
              )}
              <button
                type="button"
                className="text-[12px] text-ink underline"
                onClick={() => setOpen(false)}
              >
                Done
              </button>
            </div>
          </DialogContent>
        )}
      </Dialog>
    </>
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
      {/* #689 — `sm`'s padding/text fit this site; only its height (80px, a
          markdown body wants more room than sm's 56px default) is bespoke. */}
      <Textarea
        size="sm"
        className="min-h-20"
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

      {/* #152 — raw HTTP headers are developer tooling; a connection (below) is the
          non-technical way to send auth. Collapsed unless you go looking. */}
      <AdvancedDetails label="Headers">
        <div className="flex flex-col gap-1">
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
      </AdvancedDetails>

      {action.method !== 'GET' && (
        <Textarea
          size="sm"
          className="font-mono"
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
          <p className="text-[11px] text-muted">
            No HTTP connections yet —{' '}
            <Link href={`/w/${ws}/settings/connections`} target="_blank" className="underline underline-offset-2 hover:no-underline">
              add one
            </Link>{' '}
            to send an Authorization header without typing it here.
          </p>
        )}
      </div>

      {/* #152 — json-path response capture (items.0.id) is the most developer-y
          control in the editor: gated, with the explanation inside it. */}
      <AdvancedDetails label="Capture the response onto fields">
        <CaptureRowsEditor
          settable={settable}
          capture={capture}
          onChange={(next) => onChange({ ...action, capture: next })}
        />
        <p className="text-[11px] text-muted">
          Response captured via json-path (e.g. <code>id</code> or <code>items.0.id</code>) onto the
          fields above. Secrets from the connection are never shown in run results.
        </p>
      </AdvancedDetails>

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
          {/* #706 — KEEPS faint: a connector glyph between two selects, not
              text. Non-text graphic at 3:1, which faint clears; the selects
              either side carry the meaning. */}
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
  const settable = settableFieldsForSetValues(target.data?.fields ?? []);
  if (relationFields.length === 0) {
    return (
      <p className="text-[12px] text-muted">This database has no relations to update through.</p>
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
        ws={ws}
        settable={settable}
        members={members}
        values={action.values}
        addLabel="＋ field to set on linked…"
        onChange={(values) => onChange({ ...action, values })}
      />
    </div>
  );
}

/** Ops that take no value at all — the value input disappears for these. */
const NO_VALUE_ACTION_OPS = new Set(['is_empty', 'not_empty']);

/**
 * #274 — the compact per-action "Only if …" gate. Mirrors the rule-level condition
 * editor's flat field/op/value shape (automations-panel.tsx) rather than the full
 * nested filter builder: one clause is what the use-case needs ("only call the API
 * when Status is X"), and a single clause is already a valid server-side FilterNode.
 *
 * Choosing "always run" clears the condition entirely, so an action never carries a
 * half-built clause that would 422 on save.
 */
function ActionConditionRow({
  fields,
  condition,
  onChange,
}: {
  fields: Field[];
  condition?: ActionCondition;
  onChange: (condition: ActionCondition | undefined) => void;
}) {
  const conditionable = fields.filter((f) => opsForField(f).length > 0);
  const field = fields.find((f) => f.apiName === condition?.field);
  const ops = field ? opsForField(field) : [];
  const op = ops.find((o) => o.op === condition?.op);
  const needsValue = Boolean(condition?.op) && !NO_VALUE_ACTION_OPS.has(condition!.op);

  /** A select/multi-select/workflow clause stores an array of option ids. */
  const isOptionInput = op?.input === 'options';
  const valueAsText = Array.isArray(condition?.value)
    ? String(condition!.value[0] ?? '')
    : condition?.value === undefined || condition?.value === null
      ? ''
      : String(condition.value);

  function setValue(raw: string) {
    if (!condition) return;
    let value: unknown = raw;
    if (isOptionInput) value = raw ? [raw] : [];
    else if (op?.input === 'number') value = raw === '' ? 0 : Number(raw);
    else if (op?.input === 'boolean') value = raw === 'true';
    onChange({ ...condition, value });
  }

  return (
    <div className="flex flex-wrap items-center gap-1 border-t border-border-default pt-1.5">
      <span className="text-[11px] text-muted">Only if</span>
      <select
        className="h-6 rounded border border-border-default bg-card px-1 text-[11px] text-ink"
        value={condition?.field ?? ''}
        onChange={(e) => {
          const apiName = e.target.value;
          if (!apiName) return onChange(undefined); // "always run" clears it
          const next = fields.find((f) => f.apiName === apiName);
          const firstOp = next ? opsForField(next)[0] : undefined;
          if (!firstOp) return onChange(undefined);
          onChange({
            field: apiName,
            op: firstOp.op,
            ...(NO_VALUE_ACTION_OPS.has(firstOp.op) ? {} : { value: firstOp.input === 'options' ? [] : '' }),
          });
        }}
      >
        <option value="">always run</option>
        {conditionable.map((f) => (
          <option key={f.id} value={f.apiName}>
            {f.displayName}
          </option>
        ))}
      </select>

      {condition && ops.length > 0 && (
        <select
          className="h-6 rounded border border-border-default bg-card px-1 text-[11px] text-ink"
          value={condition.op}
          onChange={(e) => {
            const nextOp = ops.find((o) => o.op === e.target.value);
            if (!nextOp) return;
            onChange({
              field: condition.field,
              op: nextOp.op,
              ...(NO_VALUE_ACTION_OPS.has(nextOp.op) ? {} : { value: nextOp.input === 'options' ? [] : '' }),
            });
          }}
        >
          {ops.map((o) => (
            <option key={o.op} value={o.op}>
              {o.label}
            </option>
          ))}
        </select>
      )}

      {condition && needsValue && isOptionInput && (
        <select
          className="h-6 rounded border border-border-default bg-card px-1 text-[11px] text-ink"
          value={valueAsText}
          onChange={(e) => setValue(e.target.value)}
        >
          <option value="">choose…</option>
          {(field?.options ?? []).map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      )}

      {condition && needsValue && op?.input === 'boolean' && (
        <select
          className="h-6 rounded border border-border-default bg-card px-1 text-[11px] text-ink"
          value={valueAsText || 'true'}
          onChange={(e) => setValue(e.target.value)}
        >
          <option value="true">checked</option>
          <option value="false">unchecked</option>
        </select>
      )}

      {condition && needsValue && !isOptionInput && op?.input !== 'boolean' && (
        <Input
          className="h-6 w-36 text-[11px]"
          type={op?.input === 'number' ? 'number' : 'text'}
          placeholder="value"
          value={valueAsText}
          onChange={(e) => setValue(e.target.value)}
        />
      )}
    </div>
  );
}

/**
 * #152 — a plain progressive-disclosure wrapper for developer-grade controls
 * (raw JSON bodies, HTTP headers, json-path capture). Native <details> so it is
 * keyboard-accessible and needs no state plumbing; collapsed by default, and it
 * stays open once a user opens it while the editor is mounted.
 */
function AdvancedDetails({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <details className="rounded border border-border-default">
      <summary className="cursor-pointer select-none px-2 py-1 text-[11px] text-muted hover:text-ink">
        {label}
      </summary>
      <div className="flex flex-col gap-1 border-t border-border-default p-2">{children}</div>
    </details>
  );
}
