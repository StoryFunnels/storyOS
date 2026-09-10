'use client';

import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { describeDraft } from '@/lib/description-draft';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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

  return (
    <div className="mx-auto max-w-3xl p-4 sm:p-8">
      <h1 className="mb-1 text-lg font-semibold text-ink">General</h1>
      <p className="mb-6 text-[13px] text-muted">Settings for this workspace.</p>

      <section>
        <h2 className="mb-1 text-sm font-medium text-ink">Description</h2>
        <p className="mb-3 text-[13px] text-muted">
          One line saying what this workspace is for. Agents and teammates read it to understand
          what lives here.
        </p>
        <div className="flex max-w-xl flex-col gap-2">
          <textarea
            rows={3}
            value={value}
            disabled={!isAdmin || workspace.isLoading}
            onChange={(e) => setValue(e.target.value)}
            // No hard `maxLength`: silently truncating a pasted sentence teaches
            // the person nothing. Over-length is shown and Save is blocked.
            placeholder="What is this workspace for?"
            className={cn(
              'w-full resize-none rounded-[var(--radius-control)] border bg-card px-2 py-1.5 text-[13px] text-ink disabled:opacity-60',
              draft.over ? 'border-error' : 'border-border-default',
            )}
          />
          <div className="flex items-center gap-3">
            <span className={cn('text-[12px] tabular-nums', draft.over ? 'text-error' : 'text-faint')}>
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
            <p className="text-[12px] text-faint">Only an admin can change the workspace description.</p>
          )}
        </div>
      </section>

      <section className="mt-8">
        <h2 className="mb-1 text-sm font-medium text-ink">Portal branding</h2>
        <p className="mb-3 text-[13px] text-muted">
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
            {!logoValid && <span className="text-[12px] text-error">Must be an https:// URL.</span>}
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
            {!colorValid && <span className="text-[12px] text-error">A 6-digit hex colour like #3366ff.</span>}
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
          <p className="text-[12px] text-faint">
            Your logo and colour show on every plan. The &quot;Powered by StoryOS&quot; footer is
            removed on any paid plan; it stays on Free.
          </p>
          {!isAdmin && (
            <p className="text-[12px] text-faint">Only an admin can change portal branding.</p>
          )}
        </div>
      </section>
    </div>
  );
}
