'use client';

import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { describeDraft } from '@/lib/description-draft';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useSidebarMutations, useWorkspace } from '@/lib/queries';
import { apiErrorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
/** #539 — mirrors the API's own bound (workspaceBrandingSchema): https only,
 *  never data:/javascript:/a relative path a server could reinterpret. */
function isValidLogoUrl(url: string): boolean {
  return url.startsWith('https://');
}

/**
 * Workspace General settings (#457).
 *
 * This route is new because the workspace had nowhere to put this. Space and
 * database each already own a context menu to hang a description on; the
 * workspace's settings area had pages for account, api, billing, connections,
 * export, integrations, members, notifications, preferences, referrals and
 * webhooks — and nothing for the workspace itself, with `/w/{ws}/settings`
 * rendering a 404. That gap is why #400's workspace description could be written
 * by an agent and by no one else.
 *
 * The editor here is an INLINE field rather than the dialog the two menu-driven
 * levels use, because a settings page wants a field with its own Save, not a modal
 * opened from a menu. That is chrome. The rules behind it — the trim, the
 * over-limit test, the clear-to-null behaviour and the counter wording — all come
 * from `describeDraft` (`lib/description-draft.ts`), the same one definition the
 * dialog reads. The first cut of this ticket re-derived them here instead, and
 * failed verification on criterion 6 for it.
 */
export default function GeneralSettingsPage() {
  const { ws } = useParams<{ ws: string }>();
  const workspace = useWorkspace(ws);
  const { updateWorkspace } = useSidebarMutations(ws);
  const isAdmin = workspace.data?.role === 'admin';

  const [value, setValue] = useState('');
  // Seed the box once the workspace loads. Keyed on the fetched value so a
  // refetch that changes it upstream is reflected, but ordinary typing is not
  // clobbered on every render.
  const loaded = workspace.data?.description ?? '';
  useEffect(() => setValue(loaded), [loaded]);

  // #457 — same ONE definition the dialog uses. This page is an inline field
  // rather than a modal, which is a legitimate difference in chrome; the rules
  // behind it are not allowed to differ, and re-deriving them here is exactly what
  // failed verification the first time.
  const draft = describeDraft(value);
  const dirty = (draft.value ?? '') !== (workspace.data?.description ?? '');

  const save = () => {
    if (draft.over) return;
    updateWorkspace.mutate(
      { description: draft.value },
      {
        onSuccess: () => toast.success('Description saved'),
        onError: (e) => toast.error(apiErrorMessage(e, 'Could not save — try again')),
      },
    );
  };

  /**
   * #539 — the agency operator's own brand on the public portal page
   * (/v/[token]). Same inline-field-with-its-own-Save shape as Description
   * above; a SEPARATE mutation call (not folded into the description Save)
   * since the two fields have independent dirty/validity state and there's no
   * reason a description edit should also require a valid logo URL.
   */
  const loadedBranding = workspace.data?.settings?.branding;
  const [logoUrl, setLogoUrl] = useState('');
  const [accentColor, setAccentColor] = useState('');
  useEffect(() => {
    setLogoUrl(loadedBranding?.logo_url ?? '');
    setAccentColor(loadedBranding?.accent_color ?? '');
  }, [loadedBranding?.logo_url, loadedBranding?.accent_color]);

  const logoValid = logoUrl === '' || isValidLogoUrl(logoUrl);
  const colorValid = accentColor === '' || HEX_COLOR.test(accentColor);
  const brandingDirty =
    logoUrl !== (loadedBranding?.logo_url ?? '') || accentColor !== (loadedBranding?.accent_color ?? '');

  const saveBranding = () => {
    if (!logoValid || !colorValid) return;
    updateWorkspace.mutate(
      { branding: { logo_url: logoUrl || null, accent_color: accentColor || null } },
      {
        onSuccess: () => toast.success('Branding saved'),
        onError: (e) => toast.error(apiErrorMessage(e, 'Could not save — try again')),
      },
    );
  };

  /**
   * #848/#867 — the ONE place a person switches AI publishing. It is ON by default (the founder's
   * ruling): only an explicit `false` turns it off, so an untouched workspace reads as on. It lives in
   * the web app on purpose: the API refuses this setting from any token or connected AI, either
   * way (a switch an agent can flip is decorative), so a person at a browser is the only path.
   */
  const agentsMayPublish = workspace.data?.settings?.agents_may_publish_skills !== false;
  const toggleAgentsMayPublish = (next: boolean) =>
    updateWorkspace.mutate(
      { agents_may_publish_skills: next },
      {
        onSuccess: () => toast.success(next ? 'AI can share skills with the workspace' : 'AI-written skills now stay private'),
        onError: (e) => toast.error(apiErrorMessage(e, 'Could not save — try again')),
      },
    );

  return (
    <div className="mx-auto max-w-3xl p-4 sm:p-8">
      <h1 className="mb-1 text-lg font-semibold text-ink">General</h1>
      <p className="mb-6 text-body text-muted">Settings for this workspace.</p>

      <section>
        <h2 className="mb-1 text-sm font-medium text-ink">Description</h2>
        <p className="mb-3 text-body text-muted">
          One line saying what this workspace is for. Agents and teammates read it to understand
          what lives here.
        </p>
        <div className="flex max-w-xl flex-col gap-2">
          <Textarea
            rows={3}
            size="default"
            value={value}
            disabled={!isAdmin || workspace.isLoading}
            onChange={(e) => setValue(e.target.value)}
            // No hard `maxLength`: silently truncating a pasted sentence teaches
            // the person nothing. Over-length is shown and Save is blocked.
            placeholder="What is this workspace for?"
            className={cn('min-h-0 w-full resize-none disabled:opacity-60', draft.over && 'border-error')}
          />
          <div className="flex items-center gap-3">
            <span className={cn('text-label tabular-nums', draft.over ? 'text-error' : 'text-faint')}>
              {draft.hint}
            </span>
            <Button
              className="ml-auto"
              onClick={save}
              disabled={!isAdmin || draft.over || !dirty || updateWorkspace.isPending}
            >
              {updateWorkspace.isPending ? 'Saving…' : 'Save'}
            </Button>
          </div>
          {!isAdmin && (
            <p className="text-label text-faint">Only an admin can change the workspace description.</p>
          )}
        </div>
      </section>

      <section className="mt-8">
        <h2 className="mb-1 text-sm font-medium text-ink">Skills written by AI</h2>
        <p className="mb-3 text-body text-muted">
          A skill is instructions that other people&apos;s AI will follow. Skills an AI writes are
          always marked as written by an AI, so anyone reading one can see where it came from.
        </p>
        <div className="flex max-w-xl items-start justify-between gap-4 rounded-md border border-border-default bg-card p-4">
          <div>
            <Label htmlFor="agents-may-publish" className="text-sm text-ink">
              Let AI share skills with the whole workspace
            </Label>
            <p className="mt-1 text-label text-muted">
              On by default. A skill an AI creates is visible to everyone in this workspace straight
              away, and their AI can run it. It never makes a skill public and it never shares with
              chosen people only; those need a person. Turn it off to keep AI-written skills private
              to the person whose AI wrote them. Skills already shared stay shared.
            </p>
            {!isAdmin && <p className="mt-1 text-label text-faint">Only an admin can change this.</p>}
          </div>
          <Switch
            checked={agentsMayPublish}
            onCheckedChange={toggleAgentsMayPublish}
            disabled={!isAdmin || workspace.isLoading || updateWorkspace.isPending}
            aria-label="Let AI share skills with the whole workspace"
          />
        </div>
      </section>

      <section className="mt-8">
        <h2 className="mb-1 text-sm font-medium text-ink">Portal branding</h2>
        <p className="mb-3 text-body text-muted">
          Your logo and accent colour appear on the public pages you share with clients (a
          published view's link). This is per workspace — a workspace with two client brands
          needs two workspaces for now.
        </p>
        <div className="flex max-w-xl flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="branding-logo">Logo URL</Label>
            <Input
              id="branding-logo"
              value={logoUrl}
              disabled={!isAdmin || workspace.isLoading}
              onChange={(e) => setLogoUrl(e.target.value)}
              placeholder="https://your-domain.com/logo.png"
              className={cn(!logoValid && 'border-error')}
            />
            {!logoValid && <span className="text-label text-error">Must be an https:// URL.</span>}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="branding-color">Accent colour</Label>
            <div className="flex items-center gap-2">
              <input
                type="color"
                aria-label="Pick an accent colour"
                value={HEX_COLOR.test(accentColor) ? accentColor : '#000000'}
                disabled={!isAdmin || workspace.isLoading}
                onChange={(e) => setAccentColor(e.target.value)}
                className="h-8 w-8 shrink-0 cursor-pointer rounded border border-border-default bg-card p-0.5 disabled:cursor-not-allowed disabled:opacity-60"
              />
              <Input
                id="branding-color"
                value={accentColor}
                disabled={!isAdmin || workspace.isLoading}
                onChange={(e) => setAccentColor(e.target.value)}
                placeholder="#3366ff"
                className={cn('max-w-[140px]', !colorValid && 'border-error')}
              />
            </div>
            {!colorValid && <span className="text-label text-error">A 6-digit hex colour like #3366ff.</span>}
          </div>
          <div className="flex items-center gap-3">
            <Button
              className="ml-auto"
              onClick={saveBranding}
              disabled={!isAdmin || !logoValid || !colorValid || !brandingDirty || updateWorkspace.isPending}
            >
              {updateWorkspace.isPending ? 'Saving…' : 'Save'}
            </Button>
          </div>
          {/* #539 AC — state plainly what remains on each tier, rather than
              leaving it to be discovered. Reuses #556's existing hide_branding
              rule (Free vs every paid plan) — no second branding rule. */}
          <p className="text-label text-faint">
            Your logo and colour show on every plan. The &quot;Powered by StoryOS&quot; footer is
            removed on any paid plan; it stays on Free.
          </p>
          {!isAdmin && (
            <p className="text-label text-faint">Only an admin can change portal branding.</p>
          )}
        </div>
      </section>
    </div>
  );
}
