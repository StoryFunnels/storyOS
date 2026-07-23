'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, GitBranch, Info } from 'lucide-react';
import { toast } from 'sonner';
import { api, API_URL } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';

interface GithubConfig {
  repos: string[];
  has_token: boolean;
  connected: boolean;
  installation_id: number | null;
}

interface InstallRepo {
  full_name: string;
  private: boolean;
}

/** GitHub integration setup (MN-099 / #247) — token import + App connect + repo picker. */
export default function GitHubIntegrationPage() {
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
      const cfg = data as unknown as GithubConfig;
      setRepos((prev) => prev || cfg.repos.join('\n'));
      return cfg;
    },
  });

  const connected = Boolean(config.data?.connected);

  // #247 repo picker: the installation's repos, only once connected.
  const installRepos = useQuery({
    queryKey: ['github-install-repos', ws],
    enabled: connected,
    queryFn: async () => {
      const { data, error } = await api.GET(
        '/api/v1/workspaces/{ws}/integrations/github/repos',
        { params: { path: { ws } } } as never,
      );
      if (error) throw error;
      return data as unknown as { repos: InstallRepo[]; selected: string[] };
    },
  });

  const save = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = { repos: repos.split('\n').map((r) => r.trim()).filter(Boolean) };
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

  // Persist the chosen subset from the repo picker.
  const saveSelection = useMutation({
    mutationFn: async (selected: string[]) => {
      const { error } = await api.POST('/api/v1/workspaces/{ws}/integrations/github', {
        params: { path: { ws } },
        body: { repos: selected } as never,
      } as never);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Watched repositories updated');
      void qc.invalidateQueries({ queryKey: ['github-config', ws] });
      void qc.invalidateQueries({ queryKey: ['github-install-repos', ws] });
    },
    onError: () => toast.error('Could not update repositories'),
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
    onError: (error) => toast.error((error as { error?: { message?: string } })?.error?.message ?? 'Sync failed'),
  });

  // Start the App connect: a top-level navigation so GitHub's install screen loads
  // (the API 302s there). The session cookie authenticates the redirect.
  function connect() {
    window.location.href = `${API_URL}/api/v1/workspaces/${ws}/integrations/github/connect`;
  }

  return (
    <div className="mx-auto max-w-2xl p-4 sm:p-8">
      <Link href={`/w/${ws}/settings/integrations`} className="mb-4 inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-ink">
        <ArrowLeft className="h-3.5 w-3.5" /> Integrations
      </Link>
      <div className="mb-3 flex items-center gap-2">
        <GitBranch className="h-6 w-6 text-ink" />
        <h1 className="text-lg font-semibold text-ink">GitHub</h1>
        {connected ? (
          <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] text-ink">
            connected · installation {config.data?.installation_id}
          </span>
        ) : (
          config.data?.has_token && <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] text-ink">token set</span>
        )}
      </div>
      <p className="mb-5 text-[13px] text-muted">
        Imports Issues and Pull Requests into a GitHub space and keeps them fresh on every sync. PRs auto-link
        to issues referenced by <code className="text-ink">#number</code> in the title or the branch name.
      </p>

      {/* GitHub App connect (#247) */}
      <div className="mb-6 rounded-[var(--radius-control)] border border-border-default bg-card p-4">
        <h2 className="mb-1 text-[14px] font-semibold text-ink">Connect the GitHub App</h2>
        <p className="mb-3 text-[13px] text-muted">
          Connect an installation to post a backlink comment on linked pull requests and to pick which
          repositories StoryOS watches — no personal token required.
        </p>
        {connected ? (
          <div className="flex flex-col gap-3">
            <div className="text-[13px] text-ink-secondary">
              Connected as installation <strong>{config.data?.installation_id}</strong>
              {installRepos.data && <> · watching {config.data?.repos.length ?? 0} of {installRepos.data.repos.length} repos</>}
            </div>
            {installRepos.isLoading && <p className="text-[13px] text-muted">Loading repositories…</p>}
            {installRepos.data && (
              <RepoPicker
                repos={installRepos.data.repos}
                selected={config.data?.repos ?? []}
                saving={saveSelection.isPending}
                onSave={(sel) => saveSelection.mutate(sel)}
              />
            )}
            <div>
              <Button size="sm" variant="secondary" onClick={connect}>Reconnect / change installation</Button>
            </div>
          </div>
        ) : (
          <Button size="sm" onClick={connect}>Connect GitHub</Button>
        )}
      </div>

      <div className="flex flex-col gap-3">
        <h2 className="text-[14px] font-semibold text-ink">Or use a personal access token</h2>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="gh-token">Personal access token {config.data?.has_token && '(saved — enter to replace)'}</Label>
          <Input id="gh-token" type="password" placeholder="ghp_… (repo read scope)" value={token} onChange={(e) => setToken(e.target.value)} />
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
          <Button size="sm" variant="secondary" onClick={() => save.mutate()} disabled={save.isPending}>Save</Button>
          <Button size="sm" onClick={() => sync.mutate()} disabled={sync.isPending || (!config.data?.has_token && !connected)}>
            {sync.isPending ? 'Syncing…' : 'Sync now'}
          </Button>
        </div>
        {summary && (
          <p className="text-[13px] text-ink-secondary">
            Imported <strong>{summary.issues}</strong> issues, <strong>{summary.pulls}</strong> pull requests,{' '}
            <strong>{summary.linked}</strong> auto-links.{' '}
            <Link href={`/w/${ws}`} className="text-info underline-offset-2 hover:underline" onClick={() => router.refresh()}>
              See the GitHub space →
            </Link>
          </p>
        )}
      </div>

      <ReviewSettingsSection ws={ws} />
    </div>
  );
}

interface ReviewSettings {
  enabled: boolean;
  auto_convert_draft: boolean;
  default_merge_strategy: 'merge' | 'squash' | 'rebase';
  code_theme: 'auto' | 'light' | 'dark';
  code_font: 'mono' | 'mono_lig' | 'system';
  notifications: { review_requests: boolean; comments_mentions: boolean };
}

/** A patch — every field optional, `notifications`' own booleans too. */
type ReviewSettingsPatch = Partial<Omit<ReviewSettings, 'notifications'>> & {
  notifications?: Partial<ReviewSettings['notifications']>;
};

/** Code & reviews settings (#43 AC 5): enable toggle, auto-convert draft PRs,
 * default merge strategy, code theme/font, review notifications. Plus GitLab,
 * tracked as an explicit "coming soon" rather than silently absent. */
function ReviewSettingsSection({ ws }: { ws: string }) {
  const qc = useQueryClient();
  const settings = useQuery({
    queryKey: ['github-review-settings', ws],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/integrations/github/review-settings', {
        params: { path: { ws } },
      } as never);
      if (error) throw error;
      return data as unknown as ReviewSettings;
    },
  });

  const save = useMutation({
    mutationFn: async (patch: ReviewSettingsPatch) => {
      const { data, error } = await api.POST('/api/v1/workspaces/{ws}/integrations/github/review-settings', {
        params: { path: { ws } },
        body: patch as never,
      } as never);
      if (error) throw error;
      return data as unknown as ReviewSettings;
    },
    onMutate: (patch) => {
      qc.setQueryData(['github-review-settings', ws], (old: ReviewSettings | undefined) =>
        old ? { ...old, ...patch, notifications: { ...old.notifications, ...(patch.notifications ?? {}) } } : old,
      );
    },
    onError: () => {
      toast.error('Could not save Code & reviews settings');
      void qc.invalidateQueries({ queryKey: ['github-review-settings', ws] });
    },
  });

  const s = settings.data;
  if (!s) return null;

  return (
    <div className="mt-8 border-t border-border-default pt-6">
      <h2 className="mb-1 text-[14px] font-semibold text-ink">Code &amp; reviews</h2>
      <p className="mb-4 text-[13px] text-muted">
        Settings for the in-app Reviews surface (#43) — approving, requesting changes, and reading diffs without
        leaving StoryOS.
      </p>

      <div className="flex flex-col gap-4 rounded-[var(--radius-control)] border border-border-default bg-card p-4">
        <Row
          label="Enable Code & reviews"
          hint="Turns off the Reviews sidebar section and its API for this workspace."
        >
          <Switch checked={s.enabled} onCheckedChange={(v) => save.mutate({ enabled: v })} aria-label="Enable Code & reviews" />
        </Row>

        <Row
          label="Auto-convert draft PRs"
          hint="Submitting a review on a draft PR also marks it ready for review on GitHub."
        >
          <Switch
            checked={s.auto_convert_draft}
            onCheckedChange={(v) => save.mutate({ auto_convert_draft: v })}
            aria-label="Auto-convert draft PRs"
          />
        </Row>

        <Row label="Default merge strategy">
          <select
            value={s.default_merge_strategy}
            onChange={(e) => save.mutate({ default_merge_strategy: e.target.value as ReviewSettings['default_merge_strategy'] })}
            className="rounded-[var(--radius-control)] border border-border-default bg-surface px-2 py-1 text-[13px] text-ink"
          >
            <option value="squash">Squash and merge</option>
            <option value="merge">Create a merge commit</option>
            <option value="rebase">Rebase and merge</option>
          </select>
        </Row>

        <Row label="Code theme">
          <select
            value={s.code_theme}
            onChange={(e) => save.mutate({ code_theme: e.target.value as ReviewSettings['code_theme'] })}
            className="rounded-[var(--radius-control)] border border-border-default bg-surface px-2 py-1 text-[13px] text-ink"
          >
            <option value="auto">Match system</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </Row>

        <Row label="Code font">
          <select
            value={s.code_font}
            onChange={(e) => save.mutate({ code_font: e.target.value as ReviewSettings['code_font'] })}
            className="rounded-[var(--radius-control)] border border-border-default bg-surface px-2 py-1 text-[13px] text-ink"
          >
            <option value="mono">Monospace</option>
            <option value="mono_lig">Monospace (ligatures)</option>
            <option value="system">System font</option>
          </select>
        </Row>

        <div className="border-t border-border-default pt-3">
          <p className="mb-2 text-[12px] font-medium uppercase tracking-wider text-faint">Review notifications</p>
          <Row label="Comments & mentions">
            <Switch
              checked={s.notifications.comments_mentions}
              onCheckedChange={(v) => save.mutate({ notifications: { comments_mentions: v } })}
              aria-label="Notify on comments and mentions"
            />
          </Row>
          <Row label="Review requests">
            <Switch
              checked={s.notifications.review_requests}
              onCheckedChange={(v) => save.mutate({ notifications: { review_requests: v } })}
              aria-label="Notify on review requests"
            />
          </Row>
        </div>

        <div className="flex items-center justify-between border-t border-border-default pt-3 opacity-60">
          <span className="flex items-center gap-1.5 text-[13px] text-ink-secondary">
            GitLab
            <span title="GitLab support is planned but not built yet — this toggle is a placeholder.">
              <Info className="h-3.5 w-3.5 text-faint" />
            </span>
          </span>
          <span className="rounded-full bg-surface px-2 py-0.5 text-[11px] text-muted">Coming soon</span>
        </div>
      </div>
    </div>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="flex flex-col">
        <span className="text-[13px] text-ink-secondary">{label}</span>
        {hint && <span className="text-[11px] text-faint">{hint}</span>}
      </span>
      {children}
    </div>
  );
}

/** Checkbox list of installation repos; commits the chosen subset on Save. */
function RepoPicker({
  repos,
  selected,
  saving,
  onSave,
}: {
  repos: InstallRepo[];
  selected: string[];
  saving: boolean;
  onSave: (selected: string[]) => void;
}) {
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(selected));
  const toggle = (name: string) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  return (
    <div className="flex flex-col gap-2">
      <div className="max-h-56 overflow-y-auto rounded-[var(--radius-control)] border border-border-default">
        {repos.map((r) => (
          <label key={r.full_name} className="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-[13px] text-ink hover:bg-accent-soft">
            <input type="checkbox" checked={chosen.has(r.full_name)} onChange={() => toggle(r.full_name)} />
            <span className="font-mono">{r.full_name}</span>
            {r.private && <span className="rounded bg-surface px-1 text-[10px] text-muted">private</span>}
          </label>
        ))}
      </div>
      <div>
        <Button size="sm" variant="secondary" disabled={saving} onClick={() => onSave([...chosen])}>
          {saving ? 'Saving…' : 'Save watched repositories'}
        </Button>
      </div>
    </div>
  );
}
