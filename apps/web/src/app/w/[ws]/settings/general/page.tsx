'use client';

import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { describeDraft } from '@/lib/description-draft';
import { workspaceNameDraft } from '@/lib/workspace-name';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { AdvancedSection, SettingsBox, SettingsPageBody, SettingsPageHeader } from '@/components/settings/settings-chrome';
import { useSidebarMutations, useWorkspace } from '@/lib/queries';
import { apiErrorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';

/** The Settings pages' field label: the prototype's 12px semibold, one step under the field it labels (#974 design). */
const FIELD_LABEL = 'text-label font-semibold';
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
/** #539 — mirrors the API's own bound (workspaceBrandingSchema): https only,
 *  never data:/javascript:/a relative path a server could reinterpret. */
function isValidLogoUrl(url: string): boolean {
  return url.startsWith('https://');
}

/**
 * Workspace General settings (#457, rebuilt by ticket #1186 to Dara's #974 design).
 *
 * The page is who this workspace IS, for people and for agents: its NAME (editable here for the first time: the API has always
 * accepted `name`, the web app never offered a field) and its one-line description, saved together by one Save that sends only what
 * changed. The client-portal branding is a power control and sits under a labelled "Advanced".
 *
 * The description's rules (the trim, the over-limit test, the clear-to-null behaviour and the counter wording) come from
 * `describeDraft` (`lib/description-draft.ts`), the same one definition the dialog reads (#457's criterion 6). The name's rules come
 * from `workspaceNameDraft` (`lib/workspace-name.ts`), which the schema test pins to the server.
 */
export default function GeneralSettingsPage() {
  const { ws } = useParams<{ ws: string }>();
  const workspace = useWorkspace(ws);
  const { updateWorkspace } = useSidebarMutations(ws);
  const isAdmin = workspace.data?.role === 'admin';

  // Seed the boxes once the workspace loads. Keyed on the fetched value so a refetch that changes it upstream is reflected,
  // but ordinary typing is not clobbered on every render.
  const loadedName = workspace.data?.name ?? '';
  const [name, setName] = useState('');
  useEffect(() => setName(loadedName), [loadedName]);
  const loadedDescription = workspace.data?.description ?? '';
  const [value, setValue] = useState('');
  useEffect(() => setValue(loadedDescription), [loadedDescription]);

  const nameDraft = workspaceNameDraft(name, loadedName);
  const draft = describeDraft(value);
  const descriptionDirty = (draft.value ?? '') !== loadedDescription;
  // An empty name is shown as an error only once the person has touched the box: before the workspace loads it is simply unseeded.
  const nameError = workspace.data && name !== loadedName ? nameDraft.error : null;
  const nameDirty = name.trim() !== loadedName;
  const canSave = isAdmin && !updateWorkspace.isPending && (nameDirty || descriptionDirty) && nameDraft.error === null && !draft.over;

  const save = () => {
    if (!canSave) return;
    updateWorkspace.mutate(
      {
        ...(nameDirty && nameDraft.value !== null ? { name: nameDraft.value } : {}),
        ...(descriptionDirty ? { description: draft.value } : {}),
      },
      {
        onSuccess: () => toast.success(nameDirty ? 'Workspace saved' : 'Description saved'),
        onError: (e) => toast.error(apiErrorMessage(e, 'Could not save — try again')),
      },
    );
  };

  /**
   * #539 — the agency operator's own brand on the public portal page
   * (/v/[token]). Same inline-field-with-its-own-Save shape as the description
   * above; a SEPARATE mutation call since the two fields have independent
   * dirty/validity state and there is no reason a description edit should also
   * require a valid logo URL.
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
      <SettingsPageHeader title="General" lead="Who this workspace is, for people and for agents" />

      <SettingsPageBody>
        <SettingsBox>
          <div className="flex flex-col gap-1.5 px-3.5 py-3">
            <Label htmlFor="workspace-name" className={FIELD_LABEL}>Workspace name</Label>
            <Input
              size="sm"
              id="workspace-name"
              value={name}
              disabled={!isAdmin || workspace.isLoading}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') save();
              }}
              aria-invalid={nameError ? true : undefined}
              aria-describedby="workspace-name-hint"
              className={cn('max-w-[420px]', nameError && 'border-error')}
            />
            <span id="workspace-name-hint" className={cn('text-label', nameError ? 'text-error' : 'text-muted')}>
              {nameError ?? 'Shown in the sidebar, the workspace switcher and the Settings pages.'}
            </span>
          </div>
          <div className="flex flex-col gap-1.5 px-3.5 pb-3">
            <Label htmlFor="workspace-description" className={FIELD_LABEL}>Description</Label>
            <Textarea
              id="workspace-description"
              rows={3}
              size="sm"
              value={value}
              disabled={!isAdmin || workspace.isLoading}
              onChange={(e) => setValue(e.target.value)}
              // No hard `maxLength`: silently truncating a pasted sentence teaches the person nothing. Over-length is shown and Save is blocked.
              placeholder="What is this workspace for? One line. Agents read it to understand what lives here."
              className={cn('h-16 min-h-0 w-full max-w-[420px] resize-none disabled:opacity-60', draft.over && 'border-error')}
            />
            <span className={cn('text-label tabular-nums', draft.over ? 'text-error' : 'text-muted')}>{draft.hint}</span>
          </div>
          <div className="flex items-center justify-end gap-3 border-t border-border-default px-3.5 py-2.5">
            {!isAdmin && <span className="mr-auto text-label text-muted">Only an admin can change these.</span>}
            <Button onClick={save} disabled={!canSave}>
              {updateWorkspace.isPending ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </SettingsBox>

        <AdvancedSection title="Client portal branding" summary="logo and accent colour on links you share">
          <div className="flex flex-col gap-4 px-3.5 py-3">
            <p className="text-body text-muted">
              Your logo and accent colour appear on the public pages you share with clients (a published view&apos;s link). This is per
              workspace: a workspace with two client brands needs two workspaces for now.
            </p>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="branding-logo" className={FIELD_LABEL}>Logo URL</Label>
              <Input
                size="sm"
                id="branding-logo"
                value={logoUrl}
                disabled={!isAdmin || workspace.isLoading}
                onChange={(e) => setLogoUrl(e.target.value)}
                placeholder="https://your-domain.com/logo.png"
                className={cn('max-w-[420px]', !logoValid && 'border-error')}
              />
              {!logoValid && <span className="text-label text-error">Must be an https:// URL.</span>}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="branding-color" className={FIELD_LABEL}>Accent colour</Label>
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
                  size="sm"
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
            {/* #539 AC — state plainly what remains on each tier, rather than leaving it to be discovered. Reuses #556's existing
                hide_branding rule (Free vs every paid plan): no second branding rule. */}
            <p className="text-label text-muted">
              Your logo and colour show on every plan. The &quot;Powered by StoryOS&quot; footer is removed on any paid plan; it stays on
              Free.
            </p>
          </div>
          <div className="flex items-center justify-end gap-3 border-t border-border-default px-3.5 py-2.5">
            {!isAdmin && <span className="mr-auto text-label text-muted">Only an admin can change portal branding.</span>}
            <Button
              variant="secondary"
              onClick={saveBranding}
              disabled={!isAdmin || !logoValid || !colorValid || !brandingDirty || updateWorkspace.isPending}
            >
              Save branding
            </Button>
          </div>
        </AdvancedSection>
      </SettingsPageBody>
    </div>
  );
}
