'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, API_URL } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { IntegrationSetupGuide } from '@/components/integration-setup-guide';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { SetupDisclosure } from '@/components/settings/setup-disclosure';
import { AdvancedSection, SettingsBox, SettingsRow } from '@/components/settings/settings-chrome';
import { GithubUntracked } from '@/components/settings/github-untracked';
import { trackRequestBody } from '@/lib/github-untracked';
import { ProviderConnectionCard, ProviderPageHeader } from '@/components/settings/provider-card';

interface GithubConfig {
  repos: string[];
  has_token: boolean;
  connected: boolean;
  installation_id: number | null;
  /** #828: deliveries received for repos that are not selected, and so discarded. */
  ignored_deliveries?: {
    repos: Array<{ repo: string; count: number; last_seen_at: string; last_event?: string }>;
    other_count: number;
  };
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
  const [summary, setSummary] = useState<{ issues: number; pulls: number; linked: number } | null>(
    null,
  );

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
  // Something is saved (the App or a token): the card leads and setup waits under its disclosure.
  const hasCredential = connected || Boolean(config.data?.has_token);

  // #247 repo picker: the installation's repos, only once connected.
  const installRepos = useQuery({
    queryKey: ['github-install-repos', ws],
    enabled: connected,
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/integrations/github/repos', {
        params: { path: { ws } },
      } as never);
      if (error) throw error;
      return data as unknown as { repos: InstallRepo[]; selected: string[] };
    },
  });

  const save = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        repos: repos
          .split('\n')
          .map((r) => r.trim())
          .filter(Boolean),
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
      void qc.invalidateQueries({ queryKey: ['integration-facts', ws] });
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
      void qc.invalidateQueries({ queryKey: ['integration-facts', ws] });
      void qc.invalidateQueries({ queryKey: ['github-install-repos', ws] });
    },
    onError: () => toast.error('Could not update repositories'),
  });

  // Ticket #1221: Track = the same selection call as the picker, with this repository added. The row goes away when the re-read
  // config no longer reports it (the list is filtered by the fresh selection), not because the click succeeded.
  const track = useMutation({
    mutationFn: async (repo: string) => {
      const { error } = await api.POST('/api/v1/workspaces/{ws}/integrations/github', {
        params: { path: { ws } },
        body: trackRequestBody(config.data?.repos ?? [], repo) as never,
      } as never);
      if (error) throw error;
      return repo;
    },
    onSuccess: (repo) => {
      toast.success(`Tracking ${repo}`);
      setRepos('');
      void qc.invalidateQueries({ queryKey: ['github-config', ws] });
      void qc.invalidateQueries({ queryKey: ['integration-facts', ws] });
      void qc.invalidateQueries({ queryKey: ['github-install-repos', ws] });
    },
    onError: () => toast.error('Could not track that repository'),
  });

  const sync = useMutation({
    mutationFn: async () => {
      const { data, error } = await api.POST('/api/v1/workspaces/{ws}/integrations/github/sync', {
        params: { path: { ws } },
      } as never);
      if (error) throw error;
      return data as unknown as {
        issues: number;
        pulls: number;
        linked: number;
        skipped?: { repo: string; reason: string }[];
      };
    },
    onSuccess: (result) => {
      setSummary(result);
      void qc.invalidateQueries();
      const skipped = result.skipped ?? [];
      const base = `Synced ${result.issues} issues, ${result.pulls} PRs, ${result.linked} auto-links`;
      if (skipped.length > 0) {
        // #193: partial success — one or more repos couldn't be read (no access /
        // not found); the rest synced. Name them so the user can fix the config.
        toast.warning(
          `${base}. Skipped ${skipped.length}: ${skipped.map((s) => s.repo).join(', ')}`,
        );
      } else {
        toast.success(base);
      }
    },
    onError: (error) =>
      toast.error((error as { error?: { message?: string } })?.error?.message ?? 'Sync failed'),
  });

  // Start the App connect: a top-level navigation so GitHub's install screen loads
  // (the API 302s there). The session cookie authenticates the redirect.
  function connect() {
    window.location.href = `${API_URL}/api/v1/workspaces/${ws}/integrations/github/connect`;
  }

  return (
    <div className="mx-auto max-w-3xl p-4 sm:p-8">
      <div className="mb-5 flex flex-col gap-[18px]">
        <ProviderPageHeader ws={ws} id="github">
          Imports Issues and Pull Requests into a GitHub space and keeps them fresh on every sync.
          PRs auto-link to issues referenced by <code className="text-ink">#number</code> in the
          title or the branch name.
        </ProviderPageHeader>
        <ProviderConnectionCard ws={ws} id="github" />
      </div>

      {/* #828 / ticket #1221: deliveries from repositories outside the selection, with the one action each has. */}
      <div className="mb-5 empty:hidden">
        <GithubUntracked
          ignored={config.data?.ignored_deliveries}
          tracked={config.data?.repos ?? []}
          tracking={track.isPending ? (track.variables ?? null) : null}
          onTrack={(repo) => track.mutate(repo)}
        />
      </div>

      {hasCredential && (
        <div className="mb-5" data-testid="github-watched">
        <SettingsBox title="Watched repositories">
          {installRepos.isLoading && <p className="px-3.5 py-3 text-body text-muted">Loading repositories…</p>}
          {installRepos.data && (
            <RepoPicker
              key={(config.data?.repos ?? []).join('|')}
              repos={installRepos.data.repos}
              selected={config.data?.repos ?? []}
              saving={saveSelection.isPending}
              onSave={(sel) => saveSelection.mutate(sel)}
            />
          )}
          <div className="border-t border-border-default px-3.5 py-2.5">
            <Button
              size="sm"
              onClick={() => sync.mutate()}
              disabled={sync.isPending || !hasCredential}
            >
              {sync.isPending ? 'Syncing…' : 'Sync now'}
            </Button>
          </div>
          {summary && (
            <p className="border-t border-border-default px-3.5 py-2.5 text-body text-ink-secondary">
              Imported <strong>{summary.issues}</strong> issues, <strong>{summary.pulls}</strong>{' '}
              pull requests, <strong>{summary.linked}</strong> auto-links.{' '}
              <Link
                href={`/w/${ws}`}
                className="text-info underline-offset-2 hover:underline"
                onClick={() => router.refresh()}
              >
                See the GitHub space →
              </Link>
            </p>
          )}
        </SettingsBox>
        </div>
      )}

      <SetupDisclosure label="GitHub" connected={hasCredential}>
        <div className="flex flex-col gap-[18px]">
        <IntegrationSetupGuide
          steps={[
            {
              label: 'Connect GitHub',
              description: 'Install the GitHub App, or save a personal access token.',
              complete: connected || Boolean(config.data?.has_token),
            },
            {
              label: 'Choose repositories',
              description: 'Select the repositories StoryOS should watch and import.',
              complete: Boolean(config.data?.repos.length),
            },
            {
              label: 'Sync and inspect',
              description: 'Run the first sync, then open the generated GitHub space.',
              complete: Boolean(summary),
            },
          ]}
        />
        {/* GitHub App connect (#247) */}
        <SettingsBox title="Connect the GitHub App">
          <p className="px-3.5 pt-3 text-body text-muted">
            Connect an installation to post a backlink comment on linked pull requests and to pick
            which repositories StoryOS watches — no personal token required.
          </p>
          {connected ? (
            <div className="flex flex-col gap-3 px-3.5 py-3">
              <div className="text-body text-ink-secondary">
                Connected as installation <strong>{config.data?.installation_id}</strong>
                {installRepos.data && (
                  <>
                    {' '}
                    · watching {config.data?.repos.length ?? 0} of {installRepos.data.repos.length}{' '}
                    repos
                  </>
                )}
              </div>
              <div>
                <Button size="sm" variant="secondary" onClick={connect}>
                  Reconnect / change installation
                </Button>
              </div>
            </div>
          ) : (
            <p className="px-3.5 pb-3 pt-2 text-body text-muted">
              Use Connect GitHub above to install the app, or save a personal access token below.
            </p>
          )}
        </SettingsBox>

        <SettingsBox title="Or use a personal access token">
          <div className="flex flex-col gap-1.5 px-3.5 pt-3">
            <Label htmlFor="gh-token" className="text-label font-semibold">
              Personal access token {config.data?.has_token && '(saved — enter to replace)'}
            </Label>
            <Input size="sm"
              id="gh-token"
              type="password"
              placeholder="ghp_… (repo read scope)"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5 px-3.5 pt-3">
            <Label htmlFor="gh-repos" className="text-label font-semibold">Repositories (one owner/name per line)</Label>
            <Textarea
              id="gh-repos"
              rows={3}
              size="default"
              // `rows` alone governs height here (as it did before) — `min-h-0`
              // removes the primitive's own floor so it doesn't quietly grow.
              className="min-h-0 w-full font-mono outline-none focus:border-border-strong"
              placeholder={'acme/website\nacme/api'}
              value={repos}
              onChange={(e) => setRepos(e.target.value)}
            />
          </div>
          <div className="flex gap-2 px-3.5 py-3">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => save.mutate()}
              disabled={save.isPending}
            >
              Save
            </Button>
            {!hasCredential && (
              <Button
                size="sm"
                onClick={() => sync.mutate()}
                disabled={sync.isPending || (!config.data?.has_token && !connected)}
              >
                {sync.isPending ? 'Syncing…' : 'Sync now'}
              </Button>
            )}
          </div>
        </SettingsBox>
        </div>
      </SetupDisclosure>

      {/* Ticket #1285: workspace-wide review settings belong to a connected GitHub, in the page's Advanced disclosure, last. */}
      {hasCredential && <ReviewSettingsSection ws={ws} />}
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

/** Code & reviews settings (#43 AC 5): enable toggle, auto-convert draft PRs, default merge strategy, code theme/font, review
 * notifications. Ticket #1285: shown only once GitHub is connected, in an Advanced disclosure; the GitLab "coming soon" placeholder row is gone
 * (a user-facing row for something that does not exist). */
function ReviewSettingsSection({ ws }: { ws: string }) {
  const qc = useQueryClient();
  const settings = useQuery({
    queryKey: ['github-review-settings', ws],
    queryFn: async () => {
      const { data, error } = await api.GET(
        '/api/v1/workspaces/{ws}/integrations/github/review-settings',
        {
          params: { path: { ws } },
        } as never,
      );
      if (error) throw error;
      return data as unknown as ReviewSettings;
    },
  });

  const save = useMutation({
    mutationFn: async (patch: ReviewSettingsPatch) => {
      const { data, error } = await api.POST(
        '/api/v1/workspaces/{ws}/integrations/github/review-settings',
        {
          params: { path: { ws } },
          body: patch as never,
        } as never,
      );
      if (error) throw error;
      return data as unknown as ReviewSettings;
    },
    onMutate: (patch) => {
      qc.setQueryData(['github-review-settings', ws], (old: ReviewSettings | undefined) =>
        old
          ? {
              ...old,
              ...patch,
              notifications: { ...old.notifications, ...(patch.notifications ?? {}) },
            }
          : old,
      );
    },
    onError: () => {
      toast.error('Could not save Code & reviews settings');
      void qc.invalidateQueries({ queryKey: ['github-review-settings', ws] });
    },
  });

  const s = settings.data;
  if (!s) return null;

  const SELECT =
    'h-8 rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-body text-ink';

  return (
    <div className="mt-5" data-testid="github-review-settings">
      <AdvancedSection title="Code and reviews" summary="review notifications and code display, for the whole workspace">
        <SettingsRow
          title="Show Code & reviews"
          description="Pull requests, diffs and reviews inside StoryOS, under Reviews in the sidebar. Turn off to hide them for everyone in this workspace."
          inlineControls
        >
          <Switch checked={s.enabled} onCheckedChange={(v) => save.mutate({ enabled: v })} aria-label="Enable Code & reviews" />
        </SettingsRow>

        <SettingsRow
          title="Auto-convert draft PRs"
          description="Submitting a review on a draft PR also marks it ready for review on GitHub."
          inlineControls
        >
          <Switch
            checked={s.auto_convert_draft}
            onCheckedChange={(v) => save.mutate({ auto_convert_draft: v })}
            aria-label="Auto-convert draft PRs"
          />
        </SettingsRow>

        <SettingsRow title="Default merge strategy">
          <select
            value={s.default_merge_strategy}
            onChange={(e) => save.mutate({ default_merge_strategy: e.target.value as ReviewSettings['default_merge_strategy'] })}
            className={SELECT}
          >
            <option value="squash">Squash and merge</option>
            <option value="merge">Create a merge commit</option>
            <option value="rebase">Rebase and merge</option>
          </select>
        </SettingsRow>

        <SettingsRow title="Code theme" description="How diffs look on records">
          <select
            value={s.code_theme}
            onChange={(e) => save.mutate({ code_theme: e.target.value as ReviewSettings['code_theme'] })}
            className={SELECT}
          >
            <option value="auto">Match system</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </SettingsRow>

        <SettingsRow title="Code font">
          <select
            value={s.code_font}
            onChange={(e) => save.mutate({ code_font: e.target.value as ReviewSettings['code_font'] })}
            className={SELECT}
          >
            <option value="mono">Monospace</option>
            <option value="mono_lig">Monospace (ligatures)</option>
            <option value="system">System font</option>
          </select>
        </SettingsRow>

        <SettingsRow title="Notify on comments and mentions" inlineControls>
          <Switch
            checked={s.notifications.comments_mentions}
            onCheckedChange={(v) => save.mutate({ notifications: { comments_mentions: v } })}
            aria-label="Notify on comments and mentions"
          />
        </SettingsRow>
        <SettingsRow title="Notify when a review is requested" inlineControls>
          <Switch
            checked={s.notifications.review_requests}
            onCheckedChange={(v) => save.mutate({ notifications: { review_requests: v } })}
            aria-label="Notify on review requests"
          />
        </SettingsRow>
      </AdvancedSection>
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
    <div className="flex flex-col">
      <div className="max-h-56 overflow-y-auto">
        {repos.map((r) => (
          <label
            key={r.full_name}
            className="flex cursor-pointer items-center gap-2 px-3.5 py-1.5 text-body text-ink hover:bg-hover"
          >
            <input
              type="checkbox"
              checked={chosen.has(r.full_name)}
              onChange={() => toggle(r.full_name)}
            />
            <span className="font-mono">{r.full_name}</span>
            {r.private && (
              <span className="rounded bg-surface px-1 text-micro text-muted">private</span>
            )}
          </label>
        ))}
      </div>
      <div className="border-t border-border-default px-3.5 py-2.5">
        <Button size="sm" variant="secondary" disabled={saving} onClick={() => onSave([...chosen])}>
          {saving ? 'Saving…' : 'Save watched repositories'}
        </Button>
      </div>
    </div>
  );
}
