'use client';

import Link from 'next/link';
import { Info, ShieldCheck } from 'lucide-react';
import type { Field } from '@/components/table-view/use-table-data';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import {
  TARGET_LABEL,
  lengthFor,
  mediaFields,
  providerForTarget,
  resultFields,
  targetsFor,
  type SocialTarget,
} from './post-social-model';
import { useSocialConnections } from './use-social';

export interface PostSocialAction {
  type: 'post_social';
  connection_id: string;
  target: SocialTarget;
  text: string;
  media_field_id?: string;
  link?: string;
  result_field_id?: string;
  require_approval?: boolean;
}

/** A fresh post_social, pointed at the first usable connection when there is one. */
export function defaultPostSocial(connection?: { id: string; provider: string }): PostSocialAction {
  return {
    type: 'post_social',
    connection_id: connection?.id ?? '',
    target: (connection ? targetsFor(connection.provider)[0] : undefined) ?? 'x',
    text: '',
  };
}

/**
 * Ticket #826 / #42 Step 6 — compose a LinkedIn or X post from a record.
 *
 * Approval is the DEFAULT and stays so: leaving the select untouched sends `require_approval:
 * undefined`, which the server treats as gated. "Never" is admin-only and the server enforces it at
 * save; this form does not pretend to be the check (a clear save-time error is the contract).
 */
export function PostSocialEditor({
  ws,
  fields,
  action,
  onChange,
}: {
  ws: string;
  fields: Field[];
  action: PostSocialAction;
  onChange: (next: PostSocialAction) => void;
}) {
  const connections = useSocialConnections(ws);
  const list = connections.data ?? [];
  const connection = list.find((c) => c.id === action.connection_id);
  const targets = connection ? targetsFor(connection.provider) : [];
  const reading = lengthFor(action.target, action.text);
  const approvalValue = action.require_approval === undefined ? 'default' : action.require_approval ? 'always' : 'never';

  return (
    <div className="flex flex-col gap-1.5">
      {connections.isSuccess && list.length === 0 && (
        <div className="flex items-start gap-1.5 rounded border border-border-default bg-hover px-2 py-1.5 text-meta text-muted">
          <Info className="mt-0.5 h-3 w-3 shrink-0" />
          <span>
            No LinkedIn or X connection yet.{' '}
            <Link href={`/w/${ws}/settings/connections`} target="_blank" className="underline underline-offset-2 hover:no-underline">
              Connect one
            </Link>{' '}
            first. X needs your own X app on a tier that allows posting.
          </span>
        </div>
      )}
      <div className="flex gap-1.5">
        <select
          aria-label="Account"
          className="h-7 min-w-0 flex-1 rounded border border-border-default bg-card px-1 text-label text-ink"
          value={action.connection_id}
          onChange={(e) => {
            const next = list.find((c) => c.id === e.target.value);
            const nextTargets = next ? targetsFor(next.provider) : [];
            onChange({
              ...action,
              connection_id: e.target.value,
              // Keep the target only while the new connection can still post as it.
              target: nextTargets.includes(action.target) ? action.target : (nextTargets[0] ?? action.target),
            });
          }}
        >
          <option value="">Choose an account…</option>
          {list.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} ({c.provider}){c.status !== 'active' ? ` — ${c.status}` : ''}
            </option>
          ))}
        </select>
        <select
          aria-label="Post as"
          className="h-7 rounded border border-border-default bg-card px-1 text-label text-ink"
          value={action.target}
          disabled={targets.length <= 1}
          onChange={(e) => onChange({ ...action, target: e.target.value as SocialTarget })}
        >
          {(targets.length > 0 ? targets : [action.target]).map((t) => (
            <option key={t} value={t}>
              {TARGET_LABEL[t]}
            </option>
          ))}
        </select>
      </div>
      {connection && providerForTarget(action.target) !== connection.provider && (
        <p className="text-meta text-error" role="alert">
          This account cannot post as {TARGET_LABEL[action.target]}.
        </p>
      )}

      <Textarea
        size="sm"
        className="min-h-24"
        aria-label="Post text"
        placeholder="Post text — {Field Name} fills in from the record"
        value={action.text}
        onChange={(e) => onChange({ ...action, text: e.target.value })}
      />
      <p className={cn('text-meta tabular-nums', reading.over ? 'font-medium text-error' : 'text-muted')} role="status">
        {reading.length} / {reading.limit} for {TARGET_LABEL[action.target]}
        {reading.over ? ' — too long' : ''}. Counts the text as typed; {'{fields}'} are filled in when it runs, and a post over the limit is
        refused before it is sent.
      </p>

      <Input
        className="h-7"
        aria-label="Link"
        placeholder="Link (optional) — {Field Name} fills in"
        value={action.link ?? ''}
        onChange={(e) => onChange({ ...action, link: e.target.value || undefined })}
      />

      <label className="flex items-center gap-1.5 text-meta text-muted">
        <span className="w-24 shrink-0">Image</span>
        <select
          className="h-6 min-w-0 flex-1 rounded border border-border-default bg-card px-1 text-meta text-ink"
          value={action.media_field_id ?? ''}
          onChange={(e) => onChange({ ...action, media_field_id: e.target.value || undefined })}
        >
          <option value="">No image</option>
          {mediaFields(fields).map((f) => (
            <option key={f.id} value={f.id}>
              {f.displayName} (first attachment)
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-1.5 text-meta text-muted">
        <span className="w-24 shrink-0">Save the post link in</span>
        <select
          className="h-6 min-w-0 flex-1 rounded border border-border-default bg-card px-1 text-meta text-ink"
          value={action.result_field_id ?? ''}
          onChange={(e) => onChange({ ...action, result_field_id: e.target.value || undefined })}
        >
          <option value="">Don’t save it</option>
          {resultFields(fields).map((f) => (
            <option key={f.id} value={f.id}>
              {f.displayName}
            </option>
          ))}
        </select>
      </label>
      <p className="text-meta text-muted">
        {action.result_field_id
          ? 'If that field already has a value the post is skipped, so a record is never posted twice.'
          : 'Without a field to save into, nothing stops the same record being posted twice.'}
      </p>

      <div className="flex items-center gap-1.5 text-meta text-muted">
        <ShieldCheck className="h-3 w-3 shrink-0" />
        <span>Approval:</span>
        <select
          aria-label="Approval"
          className="h-6 rounded border border-border-default bg-card px-1 text-meta text-ink"
          value={approvalValue}
          onChange={(e) => {
            const v = e.target.value;
            onChange({ ...action, require_approval: v === 'default' ? undefined : v === 'always' });
          }}
        >
          <option value="default">Default — wait for someone to approve</option>
          <option value="always">Always require approval</option>
          <option value="never">Never (admin-only setting)</option>
        </select>
      </div>
    </div>
  );
}
