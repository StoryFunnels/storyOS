'use client';

import { X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Quill } from './quill';
import { installFailureText, installReadyToastCopy } from '@/lib/quill/install-moments';

/**
 * #1253 — what a pack install says when the person closed the dialog before it finished. Success is a plain toast with the way in;
 * Quill is on the FAILURE only, small, and LAST in the DOM: the real error and Retry come first, she sits beside them.
 */
export function toastInstallReady(opts: { packName: string; spaceName: string | null; intoExisting: boolean; goLabel: string | null; onGo: () => void }) {
  const copy = installReadyToastCopy(opts.packName, opts.spaceName, opts.intoExisting);
  toast.success(copy.title, {
    description: copy.description,
    duration: 8000,
    ...(opts.goLabel ? { action: { label: opts.goLabel, onClick: opts.onGo } } : {}),
  });
}

export function toastInstallFailed(opts: { packName: string; message: string; onRetry: () => void }) {
  return toast.custom(
    (id) => (
      <div
        role="alert"
        className="flex w-[356px] max-w-[calc(100vw-32px)] items-start gap-3 rounded-[var(--radius-card)] border border-error bg-card p-3 pl-3.5 text-body text-ink shadow-[var(--shadow-popover)]"
        data-testid="install-failed-toast"
      >
        <div className="min-w-0 flex-1">
          <b className="block font-semibold">Couldn’t install {opts.packName}</b>
          <p className="m-0 mt-0.5 leading-[1.45] text-ink-secondary">{installFailureText(opts.message)}</p>
          <div className="mt-2.5 flex gap-2">
            <Button
              type="button"
              size="sm"
              onClick={() => {
                toast.dismiss(id);
                opts.onRetry();
              }}
            >
              Retry
            </Button>
          </div>
        </div>
        <Quill pose="drop" size={40} caption="That was the soup." captionClassName="max-w-[72px]" />
        <button type="button" aria-label="Dismiss" className="p-0.5 leading-none text-muted hover:text-ink" onClick={() => toast.dismiss(id)}>
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>
    ),
    // An error stays until it is dismissed: it is the one thing a closed dialog cannot show again.
    { duration: Infinity },
  );
}
