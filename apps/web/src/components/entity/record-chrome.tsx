'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Copy, CopyPlus, Link2, MoreHorizontal, SlidersHorizontal, Star, Trash2, Plus } from 'lucide-react';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogTrigger } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { AddFieldDialog } from '@/components/table-view/add-field-dialog';
import { FieldsMenu } from '@/components/views/fields-menu';
import type { Field } from '@/components/table-view/use-table-data';
import { useFavorites } from '@/components/sidebar';
import { AUDIT_TYPES } from './entity-field-utils';
import { useSetFieldConfig } from './field-controls';

/**
 * One uniform header icon-button (#197) — every control in the record header's
 * right-side cluster (Star, Fields, Actions, Copy link, and the split-panel
 * Collapse/Maximize/Close) shares this so they line up as equal-weight squares
 * with a consistent hover background. Pair it with a `title=` tooltip.
 */
export const HEADER_ICON_BTN =
  'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted transition-colors hover:bg-hover hover:text-ink';

/** Copy the current record's URL — the single source of truth reused by the
 * always-visible header chain button and the "Copy link" menu item (#197). */
async function copyRecordLink() {
  try {
    await navigator.clipboard.writeText(window.location.href);
    toast.success('Link copied');
  } catch {
    toast.error('Could not copy link');
  }
}

/** Always-visible copy-link (chain) button sitting by the record title (#197) —
 * one click puts the shareable record URL on the clipboard. */
export function CopyLinkButton() {
  return (
    <button
      type="button"
      title="Copy link"
      aria-label="Copy link to this record"
      onClick={() => void copyRecordLink()}
      className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-faint transition-colors hover:bg-hover hover:text-ink"
    >
      <Link2 className="h-4 w-4" />
    </button>
  );
}

export function HiddenFieldRow({ ws, db, field }: { ws: string; db: string; field: Field }) {
  const setConfig = useSetFieldConfig(ws, db);
  // Clear every reason it could be hidden: an explicit hide, hide-when-empty, or
  // the audit-field default (MN-126, which keys off entity_hidden !== false).
  const reveal = () =>
    setConfig.mutate({ fieldId: field.id, config: { entity_hidden: false, hide_when_empty: false } });
  const reason =
    field.config?.['entity_hidden'] === true || AUDIT_TYPES.has(field.type) ? '' : ' (empty)';
  return (
    <div className="flex min-h-7 items-center justify-between py-0.5">
      <span className="truncate text-[12px] text-faint">
        {field.displayName}
        {reason}
      </span>
      <button className="text-[12px] text-info underline-offset-2 hover:underline" onClick={reveal}>
        Show
      </button>
    </div>
  );
}

/** "+ Add a field" — schema growth from the record page (creates a NEW field). */
export function AddFieldRow({ ws, db }: { ws: string; db: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button className="flex items-center gap-1.5 py-1 text-[12px] text-faint hover:text-ink">
          <Plus className="h-3.5 w-3.5" /> New field
        </button>
      </DialogTrigger>
      {open && <AddFieldDialog ws={ws} db={db} onDone={() => setOpen(false)} />}
    </Dialog>
  );
}

/** Star toggle in the header — adds/removes this record from the sidebar Favorites (MN-075). */
export function StarButton({ ws, rec }: { ws: string; rec: string }) {
  const qc = useQueryClient();
  const favorites = useFavorites(ws);
  const starred = (favorites.data ?? []).some((f) => f.target_type === 'record' && f.target_id === rec);
  const toggle = useMutation({
    mutationFn: async () => {
      if (starred) {
        const { error } = await api.DELETE('/api/v1/workspaces/{ws}/favorites/{type}/{id}', {
          params: { path: { ws, type: 'record', id: rec } },
        } as never);
        if (error) throw error;
      } else {
        const { error } = await api.POST('/api/v1/workspaces/{ws}/favorites', {
          params: { path: { ws } },
          body: { target_type: 'record', target_id: rec } as never,
        } as never);
        if (error) throw error;
      }
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['favorites', ws] }),
  });
  return (
    <button
      onClick={() => toggle.mutate()}
      title={starred ? 'Unstar' : 'Star'}
      aria-label={starred ? 'Remove from favorites' : 'Add to favorites'}
      className={HEADER_ICON_BTN}
    >
      <Star className={cn('h-4 w-4', starred && 'fill-[var(--accent)] text-[var(--accent)]')} />
    </button>
  );
}

/** Header Actions menu: duplicate, copy link, delete (MN-074), delegate to agent (#44). */
export function RecordActions({
  ws,
  db,
  rec,
  readOnly,
  canCreate,
  isAdmin,
}: {
  ws: string;
  db: string;
  rec: string;
  readOnly: boolean;
  canCreate: boolean;
  /** #44: delegate-to-agent rides AgentsController's existing admin-only gate. */
  isAdmin: boolean;
}) {
  const router = useRouter();
  const qc = useQueryClient();

  const duplicate = useMutation({
    mutationFn: async () => {
      const { data, error } = await api.POST(
        '/api/v1/workspaces/{ws}/databases/{db}/records/{rec}/duplicate',
        { params: { path: { ws, db, rec } } } as never,
      );
      if (error) throw error;
      return data as unknown as { id: string };
    },
    onSuccess: (r) => {
      toast.success('Record duplicated');
      void qc.invalidateQueries({ queryKey: ['records', ws, db] });
      router.push(`/w/${ws}/d/${db}/r/${r.id}`);
    },
    onError: () => toast.error('Could not duplicate'),
  });

  const remove = useMutation({
    mutationFn: async () => {
      const { error } = await api.DELETE('/api/v1/workspaces/{ws}/databases/{db}/records/{rec}', {
        params: { path: { ws, db, rec } },
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Record moved to trash');
      router.push(`/w/${ws}/d/${db}`);
      // Drop the deleted record's queries (don't refetch a 404); refresh the list.
      qc.removeQueries({ predicate: (query) => Array.isArray(query.queryKey) && query.queryKey.includes(rec) });
      void qc.invalidateQueries({ queryKey: ['records', ws, db] });
    },
    onError: () => toast.error('Could not delete'),
  });

  const [delegateOpen, setDelegateOpen] = useState(false);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className={HEADER_ICON_BTN} title="Actions" aria-label="Record actions">
            <MoreHorizontal className="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {/* This record — everyday, non-destructive actions (#197). */}
          <DropdownMenuLabel>This record</DropdownMenuLabel>
          <DropdownMenuItem onSelect={() => void copyRecordLink()}>
            <Copy className="mr-2 h-3.5 w-3.5" /> Copy link
          </DropdownMenuItem>
          {canCreate && (
            <DropdownMenuItem onSelect={() => duplicate.mutate()}>
              <CopyPlus className="mr-2 h-3.5 w-3.5" /> Duplicate
            </DropdownMenuItem>
          )}
          {isAdmin && (
            <DropdownMenuItem onSelect={() => setDelegateOpen(true)}>
              <Bot className="mr-2 h-3.5 w-3.5" /> Delegate to agent
            </DropdownMenuItem>
          )}
          {!readOnly && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-error/70">Danger</DropdownMenuLabel>
              <DropdownMenuItem
                className="text-error data-[highlighted]:bg-error/10"
                onSelect={() => remove.mutate()}
              >
                <Trash2 className="mr-2 h-3.5 w-3.5" /> Delete
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {isAdmin && <DelegateToAgentDialog ws={ws} db={db} rec={rec} open={delegateOpen} onOpenChange={setDelegateOpen} />}
    </>
  );
}

interface AgentOption {
  id: string;
  title: string;
}

/**
 * "Delegate to agent" (#44) — the record-side half of the integrations-
 * directory flagship card (the settings-side half is
 * `/settings/integrations/delegate-agent/page.tsx`). Deliberately minimal: a
 * plain `<select>` of enabled agents (there are rarely more than a handful)
 * and one button — the feature is the delegate call + the comment it posts
 * back, not the picker.
 */
function DelegateToAgentDialog({
  ws,
  db,
  rec,
  open,
  onOpenChange,
}: {
  ws: string;
  db: string;
  rec: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const [agentId, setAgentId] = useState('');

  const pack = useQuery({
    queryKey: ['agents-pack', ws],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/agents', {
        params: { path: { ws } },
      } as never);
      if (error) throw error;
      return data as unknown as { exists: boolean; id?: string };
    },
    enabled: open,
  });
  const agentsDbId = pack.data?.exists ? pack.data.id : undefined;

  const agents = useQuery({
    queryKey: ['delegate-agent-options', ws, agentsDbId],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/databases/{db}/records', {
        params: { path: { ws, db: agentsDbId! }, query: { limit: 100 } },
      } as never);
      if (error) throw error;
      const rows = (data as unknown as { data: Array<{ id: string; title: string; values: Record<string, unknown> }> }).data;
      return rows.filter((r) => r.values['enabled'] === true).map((r): AgentOption => ({ id: r.id, title: r.title }));
    },
    enabled: open && Boolean(agentsDbId),
  });

  const delegate = useMutation({
    mutationFn: async () => {
      const { error } = await api.POST('/api/v1/workspaces/{ws}/agents/{agent}/delegate', {
        params: { path: { ws, agent: agentId } },
        body: { record_id: rec } as never,
      } as never);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Delegated — the outcome will post here as a comment');
      onOpenChange(false);
      setAgentId('');
      void qc.invalidateQueries({ queryKey: ['comments', ws, db, rec] });
    },
    onError: (error) => toast.error((error as { error?: { message?: string } })?.error?.message ?? 'Could not delegate'),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Delegate to agent">
        <div className="flex flex-col gap-4">
          <p className="text-[13px] text-muted">
            The agent runs with this record as its context, through the same tool catalog a manual run uses, and
            posts its outcome back here as a comment.
          </p>
          {!pack.data?.exists ? (
            <p className="text-[13px] text-ink-secondary">
              Agents aren&apos;t enabled yet — enable them from{' '}
              <a href={`/w/${ws}/settings/integrations/delegate-agent`} className="text-accent hover:underline">
                Integrations → Delegate to agent
              </a>
              , then create at least one enabled agent record.
            </p>
          ) : (agents.data ?? []).length === 0 ? (
            <p className="text-[13px] text-ink-secondary">
              No enabled agents yet — create one in the Agents database, or enable an existing one.
            </p>
          ) : (
            <select
              className="h-8 rounded border border-border-default bg-card px-2 text-[13px] text-ink"
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              autoFocus
            >
              <option value="" disabled>
                Choose an agent…
              </option>
              {(agents.data ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.title}
                </option>
              ))}
            </select>
          )}
          <div className="flex justify-end gap-2">
            <DialogClose asChild>
              <Button type="button" variant="secondary">
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="button"
              disabled={!agentId || delegate.isPending}
              onClick={() => delegate.mutate()}
            >
              {delegate.isPending ? 'Delegating…' : 'Delegate'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** "Fields" popover: one place to toggle which fields show on the record (MN-074).
 * #175 — now the shared Fibery-parity Fields menu (search + toggle switch + field-
 * type icon). Field reordering on the record page lives on the field rows
 * themselves (per-zone drag, `entity_order`), so this picker stays visibility-only. */
export function FieldsPopover({ ws, db, fields }: { ws: string; db: string; fields: Field[] }) {
  const setConfig = useSetFieldConfig(ws, db);
  return (
    <FieldsMenu
      fields={fields}
      isVisible={(f) => f.config?.['entity_hidden'] !== true}
      onToggle={(f, next) => setConfig.mutate({ fieldId: f.id, config: { entity_hidden: !next } })}
      triggerIcon={SlidersHorizontal}
      triggerLabel="Fields"
      iconOnly
      align="end"
    />
  );
}
