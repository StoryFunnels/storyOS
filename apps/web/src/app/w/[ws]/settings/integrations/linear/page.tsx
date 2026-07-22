'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDownToLine, ArrowLeft, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/**
 * Linear import setup (MN-099) — its own page under the integrations directory.
 *
 * MN-249: a founder had this already configured (API key saved), came back
 * later, saw an *empty* key field — the key is write-only and never
 * round-trips — and didn't realize nothing further needed typing: clicking
 * "Preview import" was the whole next step. The banner below only shows once
 * `has_key` is true, so it can't mislead a not-yet-connected visitor, and the
 * preview button it drives is the same `dryRun` mutation as the one further
 * down the page — one obvious primary action instead of a wall of form
 * fields that looks unfinished.
 */
export default function LinearIntegrationPage() {
  const { ws } = useParams<{ ws: string }>();
  const qc = useQueryClient();
  const [apiKey, setApiKey] = useState('');
  const [teamKeys, setTeamKeys] = useState('');
  const [preview, setPreview] = useState<Array<{ key: string; name: string; issues: number; sprints: number; projects: number }> | null>(null);
  const [imported, setImported] = useState<{ issues: number; sprints: number; projects: number } | null>(null);

  const config = useQuery({
    queryKey: ['linear-config', ws],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/integrations/linear', {
        params: { path: { ws } },
      } as never);
      if (error) throw error;
      const cfg = data as unknown as { team_keys: string[]; has_key: boolean };
      setTeamKeys((prev) => prev || cfg.team_keys.join(', '));
      return cfg;
    },
  });

  const save = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = { team_keys: teamKeys.split(',').map((k) => k.trim()).filter(Boolean) };
      if (apiKey.trim()) body.api_key = apiKey.trim();
      const { error } = await api.POST('/api/v1/workspaces/{ws}/integrations/linear', {
        params: { path: { ws } },
        body: body as never,
      } as never);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Linear settings saved');
      setApiKey('');
      void qc.invalidateQueries({ queryKey: ['linear-config', ws] });
    },
    onError: () => toast.error('Could not save Linear settings'),
  });

  const dryRun = useMutation({
    mutationFn: async () => {
      const { data, error } = await api.POST('/api/v1/workspaces/{ws}/integrations/linear/dry-run', {
        params: { path: { ws } },
      } as never);
      if (error) throw error;
      return data as unknown as { teams: Array<{ key: string; name: string; issues: number; sprints: number; projects: number }> };
    },
    onSuccess: (result) => setPreview(result.teams),
    onError: (error) => toast.error((error as { error?: { message?: string } })?.error?.message ?? 'Preview failed'),
  });

  const run = useMutation({
    mutationFn: async () => {
      const { data, error } = await api.POST('/api/v1/workspaces/{ws}/integrations/linear/sync', {
        params: { path: { ws } },
      } as never);
      if (error) throw error;
      return data as unknown as { issues: number; sprints: number; projects: number };
    },
    onSuccess: (result) => {
      setImported(result);
      void qc.invalidateQueries();
      toast.success(`Imported ${result.issues} issues, ${result.sprints} sprints, ${result.projects} projects`);
    },
    onError: (error) => toast.error((error as { error?: { message?: string } })?.error?.message ?? 'Import failed'),
  });

  return (
    <div className="mx-auto max-w-2xl p-4 sm:p-8">
      <Link href={`/w/${ws}/settings/integrations`} className="mb-4 inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-ink">
        <ArrowLeft className="h-3.5 w-3.5" /> Integrations
      </Link>
      <div className="mb-3 flex items-center gap-2">
        <ArrowDownToLine className="h-6 w-6 text-ink" />
        <h1 className="text-lg font-semibold text-ink">Linear (import)</h1>
        {config.data?.has_key && <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] text-ink">connected</span>}
      </div>
      <p className="mb-5 text-[13px] text-muted">
        One-shot migration: each Linear team becomes a space with Issues, Sprints (from cycles) and Projects —
        states and priorities mapped, sub-issues and links preserved. Re-import updates instead of duplicating.
        Preview first, then import.
      </p>

      {/* MN-249: obvious next step for an already-connected integration — the key
          field below looks empty (write-only, never round-trips), so without this
          it's easy to assume there's more setup to do before anything can happen. */}
      {config.data?.has_key && !preview && !imported && (
        <div className="mb-5 flex flex-col gap-3 rounded-[var(--radius-card)] border border-border-default bg-accent-soft p-4 sm:flex-row sm:items-center">
          <Sparkles className="h-5 w-5 shrink-0 text-ink" />
          <div className="flex-1">
            <p className="text-[13px] font-semibold text-ink">You&apos;re already connected.</p>
            <p className="text-[13px] text-ink-secondary">
              Nothing else to fill in — click Preview import to see what would come in from Linear.
            </p>
          </div>
          <Button size="sm" onClick={() => dryRun.mutate()} disabled={dryRun.isPending} className="shrink-0">
            {dryRun.isPending ? 'Checking…' : 'Preview import →'}
          </Button>
        </div>
      )}

      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="lin-key">API key {config.data?.has_key && '(saved — enter to replace)'}</Label>
          <Input id="lin-key" type="password" placeholder="lin_api_… (Settings → API in Linear)" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="lin-teams">Team keys (comma-separated; empty = all teams)</Label>
          <Input id="lin-teams" placeholder="ENG, OPS" value={teamKeys} onChange={(e) => setTeamKeys(e.target.value)} />
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" onClick={() => save.mutate()} disabled={save.isPending}>Save</Button>
          {/* MN-249: whichever of Preview/Import is the obvious next step stays primary —
              Preview first (nothing to lose from clicking it), then Import once a preview exists. */}
          <Button
            size="sm"
            variant={preview ? 'secondary' : 'primary'}
            onClick={() => dryRun.mutate()}
            disabled={dryRun.isPending || !config.data?.has_key}
          >
            {dryRun.isPending ? 'Checking…' : 'Preview import'}
          </Button>
          <Button
            size="sm"
            variant={preview ? 'primary' : 'secondary'}
            onClick={() => run.mutate()}
            disabled={run.isPending || !config.data?.has_key}
          >
            {run.isPending ? 'Importing…' : 'Import'}
          </Button>
        </div>
        {preview && (
          <div className="rounded-[var(--radius-control)] border border-border-default bg-canvas p-3 text-[13px] text-ink-secondary">
            {preview.map((t) => (
              <p key={t.key}><strong>{t.name}</strong> ({t.key}): {t.issues} issues, {t.sprints} sprints, {t.projects} projects</p>
            ))}
            <p className="mt-1 text-muted">Nothing written yet — hit Import when this looks right.</p>
          </div>
        )}
        {imported && (
          <p className="text-[13px] text-ink-secondary">
            Done: <strong>{imported.issues}</strong> issues, <strong>{imported.sprints}</strong> sprints,{' '}
            <strong>{imported.projects}</strong> projects. Assignee names landed in a text field — invite your team and reassign from there.
          </p>
        )}
      </div>
    </div>
  );
}
