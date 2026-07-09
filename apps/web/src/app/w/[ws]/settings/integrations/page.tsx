'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { GitBranch } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/** GitHub integration v1 (MN-065): token + repos → import/refresh with auto-linking. */
export default function IntegrationsPage() {
  const { ws } = useParams<{ ws: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const [token, setToken] = useState('');
  const [repos, setRepos] = useState('');
  const [summary, setSummary] = useState<{ issues: number; pulls: number; linked: number } | null>(null);

  const config = useQuery({
    queryKey: ['github-config', ws],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/integrations/github', {
        params: { path: { ws } },
      } as never);
      if (error) throw error;
      const cfg = data as unknown as { repos: string[]; has_token: boolean };
      setRepos((prev) => prev || cfg.repos.join('\n'));
      return cfg;
    },
  });

  const save = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        repos: repos.split('\n').map((r) => r.trim()).filter(Boolean),
      };
      if (token.trim()) body.token = token.trim();
      const { error } = await api.POST('/api/v1/workspaces/{ws}/integrations/github', {
        params: { path: { ws } },
        body: body as never,
      } as never);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('GitHub settings saved');
      setToken('');
      void qc.invalidateQueries({ queryKey: ['github-config', ws] });
    },
    onError: () => toast.error('Could not save (check repo format: owner/name)'),
  });

  const sync = useMutation({
    mutationFn: async () => {
      const { data, error } = await api.POST('/api/v1/workspaces/{ws}/integrations/github/sync', {
        params: { path: { ws } },
      } as never);
      if (error) throw error;
      return data as unknown as { issues: number; pulls: number; linked: number };
    },
    onSuccess: (result) => {
      setSummary(result);
      void qc.invalidateQueries();
      toast.success(`Synced ${result.issues} issues, ${result.pulls} PRs, ${result.linked} auto-links`);
    },
    onError: (error) =>
      toast.error((error as { error?: { message?: string } })?.error?.message ?? 'Sync failed'),
  });

  return (
    <div className="mx-auto max-w-2xl p-8">
      <h1 className="mb-1 text-lg font-semibold text-ink">Integrations</h1>
      <p className="mb-6 text-[13px] text-muted">
        Tokens are stored on your server and never leave it — that's the point of self-hosting.
      </p>

      <div className="rounded-[var(--radius-card)] border border-border-default bg-card p-5">
        <div className="mb-3 flex items-center gap-2">
          <GitBranch className="h-5 w-5 text-ink" />
          <h2 className="text-sm font-semibold text-ink">GitHub</h2>
          {config.data?.has_token && (
            <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] text-ink">connected</span>
          )}
        </div>
        <p className="mb-4 text-[13px] text-muted">
          Imports Issues and Pull Requests into a GitHub space and keeps them fresh on every sync.
          PRs auto-link to issues referenced by <code className="text-ink">#number</code> in the title
          or the issue number in the branch name.
        </p>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="gh-token">
              Personal access token {config.data?.has_token && '(saved — enter to replace)'}
            </Label>
            <Input
              id="gh-token"
              type="password"
              placeholder="ghp_… (repo read scope)"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="gh-repos">Repositories (one owner/name per line)</Label>
            <textarea
              id="gh-repos"
              rows={3}
              className="w-full rounded-[var(--radius-control)] border border-border-default bg-card px-2 py-1.5 font-mono text-[13px] text-ink outline-none focus:border-border-strong"
              placeholder={'acme/website\nacme/api'}
              value={repos}
              onChange={(e) => setRepos(e.target.value)}
            />
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => save.mutate()} disabled={save.isPending}>
              Save
            </Button>
            <Button
              size="sm"
              onClick={() => sync.mutate()}
              disabled={sync.isPending || !config.data?.has_token}
            >
              {sync.isPending ? 'Syncing…' : 'Sync now'}
            </Button>
          </div>
          {summary && (
            <p className="text-[13px] text-ink-secondary">
              Imported <strong>{summary.issues}</strong> issues, <strong>{summary.pulls}</strong> pull
              requests, <strong>{summary.linked}</strong> auto-links.{' '}
              <Link href={`/w/${ws}`} className="text-info underline-offset-2 hover:underline" onClick={() => router.refresh()}>
                See the GitHub space →
              </Link>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
