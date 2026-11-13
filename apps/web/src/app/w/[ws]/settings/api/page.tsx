'use client';

import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, API_URL } from '@/lib/api';
import { useDateFormat } from '@/lib/preferences';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { confirmRevokeToken } from '@/lib/settings-confirmations';
import { canConnectAi } from '@/lib/settings-nav';
import { useWorkspace } from '@/lib/queries';
import { AdvancedSection, SettingsBox, SettingsPageBody, SettingsPageHeader, SettingsRefusal, SettingsRow } from '@/components/settings/settings-chrome';
import { currentWorkspaceId, splitTokens, workspaceLabel } from './token-scope';
import type { WorkspaceRef } from './token-scope';

interface Token {
  id: string;
  name: string;
  token_prefix: string;
  workspace_id: string | null;
  last_used_at: string | null;
  created_at: string;
}

/**
 * Ticket #1188 — API tokens is a Connections page that members reach (a token is per person) and guests do not (ticket #1091: the API
 * refuses a guest's token). The nav already hides it from a guest; this is the in-page half, so a guest who types the URL is told
 * why instead of being offered a form the API will refuse. Same predicate as the nav and Connect your AI (`canConnectAi`).
 */
export default function ApiSettingsPage() {
  const { ws } = useParams<{ ws: string }>();
  const workspace = useWorkspace(ws);
  if (workspace.isPending) return <p className="p-6 text-body text-muted">Loading…</p>;
  if (workspace.isError) {
    return (
      <p className="p-6 text-body text-error" role="alert">
        Could not check your access. Try again in a moment.
      </p>
    );
  }
  if (!canConnectAi(workspace.data.role)) {
    return (
      <SettingsRefusal title="API tokens" testId="guests-cannot">
        API tokens are for workspace members and admins. You are a guest here, so you cannot create or manage them. Ask a workspace admin if you need
        access.
      </SettingsRefusal>
    );
  }
  return <ApiTokensContent />;
}

function ApiTokensContent() {
  const { ws } = useParams<{ ws: string }>();
  const qc = useQueryClient();
  const fmt = useDateFormat();

  const tokens = useQuery({
    queryKey: ['tokens'],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/me/tokens');
      if (error) throw error;
      return (data as unknown as { data: Token[] }).data;
    },
  });

  const workspaces = useQuery({
    queryKey: ['workspaces'],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces');
      if (error) throw error;
      return data as unknown as WorkspaceRef[];
    },
  });
  const confirm = useConfirm();
  const [showOthers, setShowOthers] = useState(false);

  // Until the workspace list resolves we cannot tell which tokens are "here", so
  // render nothing rather than flash the unfiltered list this ticket removes.
  const currentId = currentWorkspaceId(ws, workspaces.data);
  const { here, elsewhere } = currentId ? splitTokens(tokens.data ?? [], currentId) : { here: [], elsewhere: [] };
  const visible = showOthers ? [...here, ...elsewhere] : here;
  const ready = tokens.isSuccess && currentId !== null;
  const currentName = workspaceLabel(currentId, workspaces.data);

  async function onRevoke(token: Token) {
    // A token from another workspace is somebody's automation, not this
    // workspace's — name both, because revoke is immediate and unrecoverable.
    // #1093 — a token of THIS workspace asks too (it used to revoke on one click); another workspace's token keeps its longer sentence.
    const ok =
      token.workspace_id !== currentId
        ? await confirm({
            title: `Revoke “${token.name}”?`,
            message: `This token belongs to ${workspaceLabel(token.workspace_id, workspaces.data)}, not ${currentName}. Anything using it stops working immediately, and it cannot be recovered — you would have to create a new token and update wherever it was used.`,
            confirmLabel: 'Revoke token',
            danger: true,
          })
        : await confirm(confirmRevokeToken(token.name, currentName));
    if (!ok) return;
    revoke.mutate(token.id);
  }

  const revoke = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await api.DELETE('/api/v1/me/tokens/{token}', {
        params: { path: { token: id } },
      });
      if (error) throw error;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['tokens'] }),
  });

  return (
    <div className="mx-auto max-w-3xl p-4 sm:p-8">
      <SettingsPageHeader
        title="API tokens"
        lead="Personal tokens for scripts, integrations, self-hosted agents and anything else that calls the StoryOS API as you"
        action={<CreateTokenDialog ws={ws} />}
      />

      <SettingsPageBody>
        <SettingsBox title={showOthers ? 'Your tokens across all workspaces' : `Your tokens for ${currentName}`} aside={ready ? visible.length : undefined}>
          {!ready && <p className="px-3.5 py-3 text-body text-muted">Loading…</p>}
          {ready && visible.length === 0 && <p className="px-3.5 py-3 text-body text-muted">No tokens in this workspace yet.</p>}
          {ready &&
            visible.map((token) => (
              <SettingsRow
                key={token.id}
                title={token.name}
                description={
                  <>
                    {showOthers && <>{workspaceLabel(token.workspace_id, workspaces.data)} · </>}
                    <code>{token.token_prefix}</code> · created {fmt.date(token.created_at)} ·{' '}
                    {token.last_used_at ? `last used ${fmt.dateTime(token.last_used_at)}` : 'never used'}
                  </>
                }
              >
                <Button variant="secondary" size="sm" onClick={() => void onRevoke(token)}>
                  Revoke
                </Button>
              </SettingsRow>
            ))}
        </SettingsBox>

        {/* Tokens belong to a person, not a workspace, so the other workspaces' are one tick away; the line says where they went. */}
        {ready && elsewhere.length > 0 ? (
          <label className="flex items-center gap-2 text-label text-muted">
            <input type="checkbox" checked={showOthers} onChange={(e) => setShowOthers(e.target.checked)} />
            Show tokens from my other workspaces ({elsewhere.length})
          </label>
        ) : (
          <p className="text-label text-muted">Tokens you made in other workspaces are listed there, not here.</p>
        )}

        <AdvancedSection title="How to use a token" summary="header, what it can do, self-managed">
          <p className="px-3.5 py-3 text-body text-muted">
            Shown once when created. A personal access token acts as you: anything you can do in the app, the token can do through the API.
            Send it as <code className="rounded bg-hover px-1">Authorization: Bearer mn_pat_…</code> against{' '}
            <a className="underline" href={`${API_URL}/api/docs`} target="_blank" rel="noreferrer">
              the API
            </a>
            . On a self-managed StoryOS, use your own address.
          </p>
        </AdvancedSection>
      </SettingsPageBody>
    </div>
  );
}

function CreateTokenDialog({ ws }: { ws: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [created, setCreated] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: async () => {
      const { data, error } = await api.POST('/api/v1/me/tokens', {
        body: { name, workspace_id: ws },
      });
      if (error) throw error;
      return data as unknown as { token: string };
    },
    onSuccess: (data) => {
      setCreated(data.token);
      void qc.invalidateQueries({ queryKey: ['tokens'] });
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setName('');
          setCreated(null);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm">New token</Button>
      </DialogTrigger>
      <DialogContent title="Create API token">
        {created ? (
          <div className="flex flex-col gap-4">
            <p className="text-body text-warning-text">
              Copy it now — this token is shown only once.
            </p>
            <div className="flex gap-2">
              <Input readOnly value={created} onFocus={(e) => e.target.select()} />
              <Button
                type="button"
                variant="secondary"
                onClick={async () => {
                  await navigator.clipboard.writeText(created);
                  toast.success('Copied');
                }}
              >
                Copy
              </Button>
            </div>
            <div className="flex justify-end">
              <DialogClose asChild>
                <Button type="button">Done</Button>
              </DialogClose>
            </div>
          </div>
        ) : (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim()) create.mutate();
            }}
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="token-name">Name</Label>
              <Input
                id="token-name"
                autoFocus
                required
                placeholder="e.g. slack-digest"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="flex justify-end gap-2">
              <DialogClose asChild>
                <Button type="button" variant="secondary">
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" disabled={create.isPending}>
                Create
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
