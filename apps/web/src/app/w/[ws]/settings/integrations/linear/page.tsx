'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowDownToLine, ArrowLeft, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { api, apiErrorMessage } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { IntegrationSetupGuide } from '@/components/integration-setup-guide';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { useDateFormat } from '@/lib/preferences';
import {
  WRITE_BACK_DISCLOSURE,
  dueIn,
  intervalOptionsFor,
  intervalWords,
  mirrorHealth,
  previewProblems,
  previewTotals,
  timeAgo,
  writeBackProblems,
  type PreviewTeam,
  type SyncStatus,
  type WriteBackStatus,
} from '@/lib/linear-mirror';

interface LinearConfig {
  team_keys: string[];
  has_key: boolean;
  auto_sync: { enabled: boolean; interval_minutes: number };
  write_back: WriteBackStatus;
  sync: SyncStatus;
}

interface SyncResult {
  issues: number;
  sprints: number;
  projects: number;
  comments?: { fetched: number; created: number; already_present: number };
  drift_flagged?: number;
  left_scope?: number;
}

/** Re-render now and then so "5 min ago" does not stay 5 min ago on a page left open to watch the mirror. */
function useNow(everyMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}

function Section({ step, title, children }: { step: number; title: string; children: React.ReactNode }) {
  return (
    <section className="mt-6 border-t border-border-default pt-5">
      <h2 className="mb-2 text-body font-semibold text-ink">
        {step}. {title}
      </h2>
      {children}
    </section>
  );
}

/** A problem that must not be skimmed past: a marker and ink-coloured words, not coloured text. */
function Problem({ children }: { children: React.ReactNode }) {
  return (
    <p role="alert" className="flex gap-2 text-body text-ink">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-error" aria-hidden />
      <span>{children}</span>
    </p>
  );
}

/**
 * Linear setup — its own page under the integrations directory (MN-099), now the whole mirror
 * (ticket #919): key and teams, a preview you check against Linear before anything is written, sync,
 * the schedule, write-back, and how the mirror is doing. The order is the order an admin acts in.
 *
 * MN-249: a founder had this already configured (API key saved), came back later, saw an *empty*
 * key field — the key is write-only and never round-trips — and didn't realize nothing further
 * needed typing: clicking "Preview import" was the whole next step. The banner below only shows
 * once `has_key` is true, so it can't mislead a not-yet-connected visitor, and the preview button
 * it drives is the same `dryRun` mutation as the one in the Preview section.
 */
export default function LinearIntegrationPage() {
  const { ws } = useParams<{ ws: string }>();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { dateTime } = useDateFormat();
  const now = useNow();
  const [apiKey, setApiKey] = useState('');
  const [teamKeys, setTeamKeys] = useState('');
  const [preview, setPreview] = useState<PreviewTeam[] | null>(null);
  const [imported, setImported] = useState<SyncResult | null>(null);

  const config = useQuery({
    queryKey: ['linear-config', ws],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/integrations/linear', {
        params: { path: { ws } },
      } as never);
      if (error) throw error;
      const cfg = data as unknown as LinearConfig;
      setTeamKeys((prev) => prev || cfg.team_keys.join(', '));
      return cfg;
    },
    // While a run is in flight, keep the health block honest instead of showing the state from before it.
    refetchInterval: (query) => (query.state.data?.sync?.running ? 5000 : false),
  });

  /** One write path for every setting. Each caller sends ONLY its own part; the API merges the rest. */
  const saveConfig = useMutation({
    mutationFn: async (body: Record<string, unknown>) => {
      const { error } = await api.POST('/api/v1/workspaces/{ws}/integrations/linear', {
        params: { path: { ws } },
        body: body as never,
      } as never);
      if (error) throw error;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['linear-config', ws] }),
    onError: (e) => toast.error(apiErrorMessage(e, 'Could not save Linear settings')),
  });

  const save = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        team_keys: teamKeys
          .split(',')
          .map((k) => k.trim())
          .filter(Boolean),
      };
      if (apiKey.trim()) body.api_key = apiKey.trim();
      await saveConfig.mutateAsync(body);
    },
    onSuccess: () => {
      toast.success('Linear settings saved');
      setApiKey('');
    },
  });

  const dryRun = useMutation({
    mutationFn: async () => {
      const { data, error } = await api.POST(
        '/api/v1/workspaces/{ws}/integrations/linear/dry-run',
        {
          params: { path: { ws } },
        } as never,
      );
      if (error) throw error;
      return data as unknown as { teams: PreviewTeam[] };
    },
    onSuccess: (result) => setPreview(result.teams),
    // A failed preview must not leave the previous one on screen: that reads as the current numbers.
    onError: (error) => {
      setPreview(null);
      toast.error(apiErrorMessage(error, 'Preview failed'));
    },
  });

  const run = useMutation({
    mutationFn: async () => {
      const { data, error } = await api.POST('/api/v1/workspaces/{ws}/integrations/linear/sync', {
        params: { path: { ws } },
      } as never);
      if (error) throw error;
      return data as unknown as SyncResult;
    },
    onSuccess: (result) => {
      setImported(result);
      void qc.invalidateQueries();
      toast.success(
        `Imported ${result.issues} issues, ${result.sprints} sprints, ${result.projects} projects`,
      );
    },
    onError: (error) => {
      // A failed run is recorded server-side too: show it in Health, not just in a toast that goes away.
      void qc.invalidateQueries({ queryKey: ['linear-config', ws] });
      toast.error(apiErrorMessage(error, 'Import failed'));
    },
  });

  const cfg = config.data;
  const scheduleOn = Boolean(cfg?.auto_sync.enabled);
  const health = cfg ? mirrorHealth(scheduleOn, cfg.sync) : 'off';
  const problems = preview ? preview.flatMap((t) => previewProblems(t)) : [];
  const totals = preview ? previewTotals(preview) : null;
  const interval = cfg?.auto_sync.interval_minutes ?? 60;

  return (
    <div className="mx-auto max-w-2xl p-4 sm:p-8">
      <Link
        href={`/w/${ws}/settings/integrations`}
        className="mb-4 inline-flex items-center gap-1.5 text-body text-muted hover:text-ink"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> Integrations
      </Link>
      <div className="mb-3 flex items-center gap-2">
        <ArrowDownToLine className="h-6 w-6 text-ink" />
        <h1 className="text-lg font-semibold text-ink">Linear (import &amp; mirror)</h1>
        {cfg?.has_key && (
          <span className="rounded-full border border-border-default bg-hover px-2 py-0.5 text-meta text-ink">
            connected
          </span>
        )}
      </div>
      <p className="mb-5 text-body text-muted">
        Each Linear team becomes a space with Issues, Sprints (from cycles) and Projects — states and
        priorities mapped, sub-issues and links preserved. Re-import updates instead of duplicating.
        Preview first, then import; switch the schedule on to keep it current.
      </p>

      {/* The stale state is the point of the loud failure: it must be on the page an admin opens, not only in an API response. */}
      {cfg && (health === 'stale' || health === 'failing') && (
        <div
          role="alert"
          data-testid="linear-mirror-banner"
          className="mb-5 rounded-[var(--radius-card)] border border-border-strong bg-card p-4"
        >
          <p className="flex items-center gap-2 text-body font-semibold text-ink">
            <AlertTriangle className="h-4 w-4 shrink-0 text-error" aria-hidden />
            {health === 'stale' ? 'This mirror has stopped updating.' : 'The last sync failed.'}
          </p>
          <p className="mt-1 text-body text-ink-secondary">
            {health === 'stale'
              ? `It is set to refresh every ${intervalWords(interval)} and has not succeeded in two of those. Last success: ${
                  cfg.sync.last_success_at ? dateTime(cfg.sync.last_success_at) : 'never'
                }.`
              : `${cfg.sync.consecutive_failures} in a row. It will try again ${dueIn(cfg.sync.next_due_at, now)}.`}
            {cfg.sync.last_error ? ` Last error: ${cfg.sync.last_error}` : ''}
          </p>
        </div>
      )}

      <IntegrationSetupGuide
        className="mb-5"
        steps={[
          {
            label: 'Save access',
            description: 'Paste a Linear API key and optionally limit the migration to team keys.',
            complete: Boolean(cfg?.has_key),
          },
          {
            label: 'Preview',
            description: 'Count the teams, issues, sprints, and projects without writing anything.',
            complete: Boolean(preview),
          },
          {
            label: 'Import and inspect',
            description: 'Create or update the Linear spaces, then review the imported records.',
            complete: Boolean(imported),
          },
        ]}
      />

      {/* MN-249: obvious next step for an already-connected integration — the key
          field below looks empty (write-only, never round-trips), so without this
          it's easy to assume there's more setup to do before anything can happen. */}
      {cfg?.has_key && !preview && !imported && (
        <div className="mb-5 flex flex-col gap-3 rounded-[var(--radius-card)] border border-border-default bg-hover p-4 sm:flex-row sm:items-center">
          <Sparkles className="h-5 w-5 shrink-0 text-ink" />
          <div className="flex-1">
            <p className="text-body font-semibold text-ink">You&apos;re already connected.</p>
            <p className="text-body text-ink-secondary">
              Nothing else to fill in — click Preview import to see what would come in from Linear.
            </p>
          </div>
          <Button
            size="sm"
            onClick={() => dryRun.mutate()}
            disabled={dryRun.isPending}
            className="shrink-0"
          >
            {dryRun.isPending ? 'Checking…' : 'Preview import →'}
          </Button>
        </div>
      )}

      <Section step={1} title="Key and teams">
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="lin-key">
              API key {cfg?.has_key && '(saved — enter to replace)'}
            </Label>
            <Input
              id="lin-key"
              type="password"
              placeholder="lin_api_… (Settings → API in Linear)"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="lin-teams">Team keys (comma-separated; empty = all teams)</Label>
            <Input
              id="lin-teams"
              placeholder="ENG, OPS"
              value={teamKeys}
              onChange={(e) => setTeamKeys(e.target.value)}
            />
          </div>
          <div>
            <Button size="sm" variant="secondary" onClick={() => save.mutate()} disabled={save.isPending}>
              Save
            </Button>
          </div>
        </div>
      </Section>

      <Section step={2} title="Preview">
        <p className="mb-3 text-body text-muted">
          Counts per team and per Linear project, checked against Linear&apos;s own totals. Nothing is
          written. Look for work that does not belong in a shared workspace before you sync.
        </p>
        <Button
          size="sm"
          variant={preview ? 'secondary' : 'primary'}
          onClick={() => dryRun.mutate()}
          disabled={dryRun.isPending || !cfg?.has_key}
        >
          {dryRun.isPending ? 'Checking…' : 'Preview import'}
        </Button>
        {dryRun.isError && (
          <div className="mt-3" data-testid="linear-preview-error">
            {/* Stays on the page (a toast does not): the server refuses a preview whose counts disagree with Linear's own, and the message carries both numbers. */}
            <Problem>{apiErrorMessage(dryRun.error, 'Preview failed')}</Problem>
          </div>
        )}
        {preview && (
          <div data-testid="linear-preview" className="mt-3 flex flex-col gap-4 rounded-[var(--radius-control)] border border-border-default bg-canvas p-3 text-body text-ink-secondary">
            {problems.length > 0 && (
              <div className="flex flex-col gap-1.5 rounded-[var(--radius-control)] border border-border-strong bg-card p-3">
                {problems.map((p) => (
                  <Problem key={p.message}>{p.message}</Problem>
                ))}
              </div>
            )}
            {totals && (
              <p>
                <strong>{totals.issues}</strong> issues would be copied
                {totals.linearTotal !== null ? (
                  <>
                    {' '}
                    of <strong>{totals.linearTotal}</strong> that Linear reports.
                  </>
                ) : (
                  <> (Linear&apos;s total was not reported).</>
                )}
              </p>
            )}
            {preview.map((t) => (
              <div key={t.key} className="flex flex-col gap-1">
                <p className="text-ink">
                  <strong>{t.name}</strong> ({t.key}): {t.issues}
                  {typeof t.linear_issue_total === 'number' ? ` of ${t.linear_issue_total}` : ''} issues,{' '}
                  {t.sprints} sprints, {t.projects} projects
                  {typeof t.comments === 'number' ? `, ${t.comments} comments` : ''}
                </p>
                {t.issues_by_project && t.issues_by_project.length > 0 && (
                  <ul className="ml-4 list-disc">
                    {t.issues_by_project.map((p) => (
                      <li key={p.project_id ?? 'none'}>
                        {p.name}: {p.issues}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
            <p className="text-muted">Nothing written yet — import when this looks right.</p>
          </div>
        )}
      </Section>

      <Section step={3} title="Sync now">
        <Button
          size="sm"
          variant={preview ? 'primary' : 'secondary'}
          onClick={() => run.mutate()}
          disabled={run.isPending || !cfg?.has_key}
        >
          {run.isPending ? 'Importing…' : 'Import'}
        </Button>
        {run.isError && (
          <div className="mt-3" data-testid="linear-sync-error">
            <Problem>{apiErrorMessage(run.error, 'Import failed')}</Problem>
          </div>
        )}
        {imported && !run.isError && (
          <p className="mt-3 text-body text-ink-secondary">
            Done: <strong>{imported.issues}</strong> issues, <strong>{imported.sprints}</strong> sprints,{' '}
            <strong>{imported.projects}</strong> projects
            {imported.comments ? `, ${imported.comments.created} new comments (${imported.comments.fetched} read)` : ''}.
            {imported.left_scope ? ` ${imported.left_scope} mirrored issues are no longer returned by Linear and were marked, not deleted.` : ''}
            {imported.drift_flagged ? ` ${imported.drift_flagged} descriptions changed here since the last sync and were flagged.` : ''} Assignee
            names landed in a text field — invite your team and reassign from there.
          </p>
        )}
      </Section>

      <Section step={4} title="Schedule">
        <div className="flex items-center gap-3">
          <Switch
            aria-label="Keep the mirror up to date automatically"
            checked={scheduleOn}
            disabled={!cfg?.has_key || saveConfig.isPending}
            onCheckedChange={(enabled) => saveConfig.mutate({ auto_sync: { enabled } })}
          />
          <span className="text-body text-ink">{scheduleOn ? 'On' : 'Off'}</span>
          <select
            aria-label="How often"
            className="h-8 rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-body text-ink disabled:opacity-50"
            value={String(interval)}
            disabled={!cfg?.has_key || saveConfig.isPending}
            onChange={(e) => saveConfig.mutate({ auto_sync: { interval_minutes: Number(e.target.value) } })}
          >
            {intervalOptionsFor(interval).map((o) => (
              <option key={o.minutes} value={o.minutes}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <p className="mt-2 text-label text-ink-secondary">
          {scheduleOn
            ? `Re-syncs every ${intervalWords(interval)}, as the person who switched it on. If it stops succeeding you will be notified once, and this page will say so.`
            : 'Off. The mirror only changes when you press Import.'}
        </p>
      </Section>

      <Section step={5} title="Write-back">
        <div className="flex items-center gap-3">
          <Switch
            aria-label="Post StoryOS comments to Linear"
            checked={Boolean(cfg?.write_back.enabled)}
            disabled={!cfg?.has_key || saveConfig.isPending}
            onCheckedChange={async (enabled) => {
              if (enabled) {
                const ok = await confirm({
                  title: 'Post StoryOS comments to Linear?',
                  message: WRITE_BACK_DISCLOSURE,
                  confirmLabel: 'Turn on write-back',
                });
                if (!ok) return;
              }
              saveConfig.mutate({ write_back: { enabled } });
            }}
          />
          <span className="text-body text-ink">{cfg?.write_back.enabled ? 'On' : 'Off'}</span>
        </div>
        <p className="mt-2 text-label text-ink-secondary">{WRITE_BACK_DISCLOSURE}</p>
        {cfg && cfg.write_back.enabled && writeBackProblems(cfg.write_back).length > 0 && (
          <div className="mt-2 flex flex-col gap-1">
            {writeBackProblems(cfg.write_back).map((p) => (
              <Problem key={p}>{p}</Problem>
            ))}
            {cfg.write_back.last_error && <p className="text-label text-ink-secondary">Last error: {cfg.write_back.last_error}</p>}
          </div>
        )}
      </Section>

      <Section step={6} title="Health">
        {cfg ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-body">
            <dt className="text-muted">Status</dt>
            <dd className="text-ink" data-testid="linear-mirror-status">
              {health === 'off'
                ? 'Schedule is off'
                : health === 'stale'
                  ? 'Stale: not updating'
                  : health === 'failing'
                    ? 'Failing'
                    : 'Healthy'}
              {cfg.sync.running ? ' · running now' : ''}
            </dd>
            <dt className="text-muted">Last success</dt>
            <dd className="text-ink">
              {cfg.sync.last_success_at ? `${dateTime(cfg.sync.last_success_at)} (${timeAgo(cfg.sync.last_success_at, now)})` : 'never'}
            </dd>
            <dt className="text-muted">Last attempt</dt>
            <dd className="text-ink">{cfg.sync.last_attempt_at ? timeAgo(cfg.sync.last_attempt_at, now) : 'never'}</dd>
            <dt className="text-muted">Failures in a row</dt>
            <dd className="text-ink">{cfg.sync.consecutive_failures}</dd>
            <dt className="text-muted">Last error</dt>
            <dd className="break-words text-ink">
              {cfg.sync.last_error
                ? `${cfg.sync.last_error}${cfg.sync.last_error_at ? ` (${timeAgo(cfg.sync.last_error_at, now)})` : ''}`
                : 'none'}
            </dd>
            <dt className="text-muted">Next run</dt>
            <dd className="text-ink">{scheduleOn ? dueIn(cfg.sync.next_due_at, now) : 'not scheduled'}</dd>
            {cfg.sync.last_run && (
              <>
                <dt className="text-muted">Last run</dt>
                <dd className="text-ink">
                  {cfg.sync.last_run.issues} issues, {cfg.sync.last_run.comments} comments read, took{' '}
                  {Math.max(1, Math.round(cfg.sync.last_run.duration_ms / 1000))} s
                  {cfg.sync.last_run.left_scope ? `, ${cfg.sync.last_run.left_scope} left Linear's scope` : ''}
                  {cfg.sync.last_run.drift_flagged ? `, ${cfg.sync.last_run.drift_flagged} descriptions flagged` : ''}
                </dd>
              </>
            )}
          </dl>
        ) : (
          <p className="text-body text-muted">Loading…</p>
        )}
      </Section>
    </div>
  );
}
