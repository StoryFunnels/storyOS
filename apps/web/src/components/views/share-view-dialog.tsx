'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import type { Field } from '@/components/table-view/use-table-data';
import { CopyRow } from './form-view';
import { useSession } from '@/lib/auth-client';
import { findMeCondition, meLabel, publishedCopyBase, swapMeForUser, uniqueName } from '@/lib/me-label';
import { SYSTEM_USER_TYPES } from './system-fields';
import type { ViewSummary, useViewMutations } from './use-view-state';

/** Mirrors public-views.service.ts's COMPUTED_TYPES exactly: a rollup/lookup/
 *  formula can read data the visitor was never otherwise shown, so it's never
 *  exposed by the "non-hidden fields" default — only when explicitly checked. */
const COMPUTED_TYPES = new Set(['rollup', 'lookup', 'formula']);

/**
 * #527 — publish/manage a view's public read-only link. Unlike the form
 * builder's share panel (form-view.tsx), a view's token can only be minted or
 * rotated by the dedicated share/unshare endpoints — never by the view's own
 * PATCH — so this dialog calls `mutations.shareView`/`unshareView` directly
 * rather than the config-patch path every other view edit uses.
 */
export function ShareViewDialog({
  open,
  onOpenChange,
  view,
  fields,
  mutations,
  existingNames = [],
  onCopyReady,
}: {
  /** #928 — names already taken in this database, so the published copy of a Me view never clashes. */
  existingNames?: string[];
  /** #928 — the copy was made; the page opens it and offers the ordinary Share dialog for it. */
  onCopyReady?: (copyId: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  view: ViewSummary;
  fields: Field[];
  mutations: ReturnType<typeof useViewMutations>;
}) {
  const share = view.config.share;
  const token = share?.public_token;

  // Seeded from the current share config — or, before a first publish, from
  // the SAME default the server itself applies (every non-computed,
  // non-relation field) so the picker reflects what "Publish" would actually
  // do rather than starting the visitor at an arbitrary, surprising state.
  const [visible, setVisible] = useState<Set<string>>(
    () =>
      new Set(
        share?.visible_field_api_names ??
          fields.filter((f) => f.type !== 'relation' && !COMPUTED_TYPES.has(f.type)).map((f) => f.apiName),
      ),
  );
  const [relationNames, setRelationNames] = useState<Set<string>>(
    () => new Set(share?.include_relation_api_names ?? []),
  );
  const [indexable, setIndexable] = useState(share?.indexable ?? false);

  const plainFields = fields.filter((f) => f.type !== 'relation');
  const relationFields = fields.filter((f) => f.type === 'relation');

  // #751 — charts/grouped tables (Phase 2 of the dashboard feature) are not
  // exposed on the public page at all yet; getPublicView only ever builds
  // `dashboard.tiles`. That's a static product-phase fact, not a redaction
  // rule, so counting it here isn't the second-copy-of-a-rule AC2 warns
  // against — it names something that isn't computed from field visibility.
  const widgetCount = view.type === 'dashboard' ? (view.config.dashboard_widgets ?? []).length : 0;

  const publicUrl = token && typeof window !== 'undefined' ? `${window.location.origin}/v/${token}` : '';
  const embedCode = publicUrl
    ? `<iframe src="${publicUrl}?embed=1" width="100%" height="600" style="border:0"></iframe>`
    : '';

  function copy(value: string, label: string) {
    void navigator.clipboard.writeText(value);
    toast.success(`${label} copied`);
  }

  function toggle(set: Set<string>, setSet: (s: Set<string>) => void, name: string, checked: boolean) {
    const next = new Set(set);
    if (checked) next.add(name);
    else next.delete(name);
    setSet(next);
  }

  function publish() {
    mutations.shareView.mutate({
      id: view.id,
      visible_field_api_names: [...visible],
      include_relation_api_names: [...relationNames],
      indexable,
    });
  }

  // #928 / #938 — a view that shows each teammate their own records cannot have a public link: a visitor is not signed
  // in, so there is no "me" and they would see an empty page. The API refuses it (422); this dialog says so first.
  // Taking the Me condition off would change the SHARED view for the whole team, so the way forward is a COPY where
  // Me becomes the author, and only the copy is published. Duplicate, patch and publish are existing calls.
  const session = useSession();
  const author = session.data?.user;
  const personFields = new Set(fields.filter((f) => f.type === 'user' || SYSTEM_USER_TYPES.has(f.type)).map((f) => f.apiName));
  const meCondition = findMeCondition(view.config.filters, personFields);
  const meField = meCondition ? fields.find((f) => f.apiName === meCondition.field) : undefined;
  const [copying, setCopying] = useState(false);

  async function publishMyCopy() {
    if (!author || !meField) return;
    setCopying(true);
    try {
      const copy = (await mutations.duplicateView.mutateAsync(view.id)) as { id: string; config?: typeof view.config };
      const base = publishedCopyBase(view.name, meField.displayName, author.name || 'My');
      const name = uniqueName(base, existingNames);
      // The duplicate never carries the public link; stripping `share` anyway keeps this independent of that.
      const { share: _share, ...rest } = copy.config ?? view.config;
      void _share;
      await mutations.updateView.mutateAsync({
        id: copy.id,
        name,
        config: { ...rest, filters: view.config.filters ? swapMeForUser(view.config.filters, author.id) : undefined },
      });
      toast.success(`Made “${name}” — the team’s view is unchanged`);
      onOpenChange(false);
      onCopyReady?.(copy.id);
    } finally {
      setCopying(false);
    }
  }

  if (meCondition && meField) {
    const label = meLabel(meField.displayName);
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent title={`“${label}” can’t have a public link`}>
          <div className="flex flex-col gap-3">
            <p className="text-body text-ink">
              This view shows each teammate their own records. Someone opening a public link isn’t signed in, so there’s
              no “me” — they’d see an empty page.
            </p>
            <p className="text-label text-muted">
              Taking “{label}” off this view would change it for everyone on your team, so StoryOS won’t do that here.
            </p>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="button" disabled={copying || !author} onClick={() => void publishMyCopy()}>
                Publish a copy with only your records
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={`Share "${view.name}"`}>
        <div className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto">
          {token ? (
            <>
              <div className="flex items-center gap-2">
                <span className="rounded-full bg-[var(--accent)] px-2 py-0.5 text-meta font-medium text-[var(--text-on-dark)]">
                  Live
                </span>
                <span className="text-label text-muted">This view is public</span>
              </div>
              <CopyRow label="Link" value={publicUrl} onCopy={() => copy(publicUrl, 'Link')} />
              <CopyRow label="Embed" value={embedCode} onCopy={() => copy(embedCode, 'Embed code')} />
            </>
          ) : (
            <p className="text-label text-muted">
              Not published. Choose which columns a visitor sees, then publish.
            </p>
          )}

          <div className="flex flex-col gap-1.5">
            <span className="text-meta font-medium uppercase tracking-wider text-faint">Visible columns</span>
            {plainFields.map((f) => (
              <label key={f.id} className="flex items-center gap-1.5 text-body text-ink">
                <input
                  type="checkbox"
                  checked={visible.has(f.apiName)}
                  onChange={(e) => toggle(visible, setVisible, f.apiName, e.target.checked)}
                />
                {f.displayName}
                {COMPUTED_TYPES.has(f.type) && <span className="text-meta text-faint">(computed)</span>}
              </label>
            ))}
          </div>

          {relationFields.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <span className="text-meta font-medium uppercase tracking-wider text-faint">
                Related records to include
              </span>
              <p className="text-meta text-faint">
                Off by default — a related record is its own data, not this view&apos;s.
              </p>
              {relationFields.map((f) => (
                <label key={f.id} className="flex items-center gap-1.5 text-body text-ink">
                  <input
                    type="checkbox"
                    checked={relationNames.has(f.apiName)}
                    onChange={(e) => toggle(relationNames, setRelationNames, f.apiName, e.target.checked)}
                  />
                  {f.displayName}
                </label>
              ))}
            </div>
          )}

          <label className="flex items-center gap-1.5 text-body text-ink">
            <input type="checkbox" checked={indexable} onChange={(e) => setIndexable(e.target.checked)} />
            Allow search engines to index this page
          </label>

          {widgetCount > 0 && (
            <p className="text-label text-faint">
              {widgetCount === 1
                ? 'This dashboard has 1 chart or grouped table — it'
                : `This dashboard has ${widgetCount} charts or grouped tables — they`}{' '}
              won&apos;t appear on the public page yet; only tiles are published.
            </p>
          )}

          <div className="flex items-center justify-between gap-2 border-t border-border-default pt-3">
            {token ? (
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={() => mutations.unshareView.mutate(view.id, { onSuccess: () => onOpenChange(false) })}
                disabled={mutations.unshareView.isPending}
              >
                Stop sharing
              </Button>
            ) : (
              <span />
            )}
            <Button type="button" size="sm" onClick={publish} disabled={mutations.shareView.isPending}>
              {token ? 'Save changes' : 'Publish'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
