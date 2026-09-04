'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import type { Field } from '@/components/table-view/use-table-data';
import { CopyRow } from './form-view';
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
}: {
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={`Share "${view.name}"`}>
        <div className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto">
          {token ? (
            <>
              <div className="flex items-center gap-2">
                <span className="rounded-full bg-[var(--accent)] px-2 py-0.5 text-[11px] font-medium text-[var(--text-on-dark)]">
                  Live
                </span>
                <span className="text-[12px] text-muted">This view is public</span>
              </div>
              <CopyRow label="Link" value={publicUrl} onCopy={() => copy(publicUrl, 'Link')} />
              <CopyRow label="Embed" value={embedCode} onCopy={() => copy(embedCode, 'Embed code')} />
            </>
          ) : (
            <p className="text-[12px] text-muted">
              Not published. Choose which columns a visitor sees, then publish.
            </p>
          )}

          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] font-medium uppercase tracking-wider text-faint">Visible columns</span>
            {plainFields.map((f) => (
              <label key={f.id} className="flex items-center gap-1.5 text-[13px] text-ink">
                <input
                  type="checkbox"
                  checked={visible.has(f.apiName)}
                  onChange={(e) => toggle(visible, setVisible, f.apiName, e.target.checked)}
                />
                {f.displayName}
                {COMPUTED_TYPES.has(f.type) && <span className="text-[11px] text-faint">(computed)</span>}
              </label>
            ))}
          </div>

          {relationFields.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <span className="text-[11px] font-medium uppercase tracking-wider text-faint">
                Related records to include
              </span>
              <p className="text-[11px] text-faint">
                Off by default — a related record is its own data, not this view&apos;s.
              </p>
              {relationFields.map((f) => (
                <label key={f.id} className="flex items-center gap-1.5 text-[13px] text-ink">
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

          <label className="flex items-center gap-1.5 text-[13px] text-ink">
            <input type="checkbox" checked={indexable} onChange={(e) => setIndexable(e.target.checked)} />
            Allow search engines to index this page
          </label>

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
