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

interface Token {
  id: string;
  name: string;
  token_prefix: string;
  last_used_at: string | null;
  created_at: string;
}

export default function ApiSettingsPage() {
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
      <div className="mb-2 flex items-center justify-between">
        <h1 className="text-lg font-semibold text-ink">API tokens</h1>
        <CreateTokenDialog ws={ws} />
      </div>
      <p className="mb-6 text-[13px] text-muted">
        Personal access tokens act as you. Use them as{' '}
        <code className="rounded bg-hover px-1">Authorization: Bearer mn_pat_…</code> against{' '}
        <a className="underline" href={`${API_URL}/api/docs`} target="_blank" rel="noreferrer">
          the API
        </a>
        .
      </p>

      <div className="overflow-hidden rounded-[var(--radius-card)] border border-border-default bg-card">
        {(tokens.data ?? []).length === 0 && (
          <p className="px-4 py-6 text-[13px] text-muted">No tokens yet.</p>
        )}
        {(tokens.data ?? []).map((token) => (
          <div
            key={token.id}
            className="flex items-center justify-between border-b border-border-default px-4 py-3 last:border-b-0"
          >
            <div>
              <p className="text-sm font-medium text-ink">{token.name}</p>
              <p className="text-[12px] text-muted">
                <code>{token.token_prefix}</code> · created{' '}
                {fmt.date(token.created_at)} ·{' '}
                {token.last_used_at
                  ? `last used ${fmt.dateTime(token.last_used_at)}`
                  : 'never used'}
              </p>
            </div>
            <Button variant="ghost" size="sm" onClick={() => revoke.mutate(token.id)}>
              Revoke
            </Button>
          </div>
        ))}
      </div>
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
            <p className="text-[13px] text-warning">
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
