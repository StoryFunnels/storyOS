'use client';

import { createContext, useCallback, useContext, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Dialog, DialogContent } from './dialog';
import { Button } from './button';

interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Style the confirm button as destructive (deletes). */
  danger?: boolean;
  /**
   * #417 — require the user to TYPE this string before the confirm button works.
   *
   * The strength of a guard should match the blast radius, and that rule has to
   * live in one place or it becomes a per-menu judgement call. A plain dialog is
   * one keystroke from a slip; typing a name cannot be done by accident.
   *
   * Reserve it for actions that destroy data the trash cannot recover — deleting
   * a space (which hard-cascades every database and record inside it) or a
   * populated database. An empty container does not need it; asking for ceremony
   * where nothing is at stake is how people learn to type the name without
   * reading the sentence above it.
   */
  requireTyped?: string;
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

/**
 * App-wide styled replacement for window.confirm (#45). Mounted once at the root so
 * any component OR hook can call `const confirm = useConfirm()` and `await confirm(...)`
 * — same promise ergonomics as the native API, without the ugly browser popup.
 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const [typed, setTyped] = useState('');
  const resolver = useRef<((value: boolean) => void) | null>(null);

  const confirm = useCallback<ConfirmFn>((options) => {
    setTyped('');
    setOpts(options);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const settle = useCallback((result: boolean) => {
    resolver.current?.(result);
    resolver.current = null;
    setOpts(null);
  }, []);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Dialog open={opts !== null} onOpenChange={(open) => !open && settle(false)}>
        {opts && (
          <DialogContent title={opts.title}>
            {opts.message && <p className="mb-5 text-[13px] leading-relaxed text-muted">{opts.message}</p>}
            {opts.requireTyped && (
              <label className="mb-5 block text-[13px] text-ink-secondary">
                Type <span className="font-medium text-ink">{opts.requireTyped}</span> to confirm
                <input
                  autoFocus
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  aria-label={`Type ${opts.requireTyped} to confirm`}
                  className="mt-1.5 h-8 w-full rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-[13px] text-ink"
                />
              </label>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => settle(false)}>
                {opts.cancelLabel ?? 'Cancel'}
              </Button>
              <Button
                variant={opts.danger ? 'destructive' : 'primary'}
                size="sm"
                /* autoFocus goes to the INPUT when one is required — focusing the
                   destructive button and letting Enter fire it would undo the
                   whole point of asking. */
                autoFocus={!opts.requireTyped}
                disabled={Boolean(opts.requireTyped) && typed !== opts.requireTyped}
                onClick={() => settle(true)}
              >
                {opts.confirmLabel ?? 'Confirm'}
              </Button>
            </div>
          </DialogContent>
        )}
      </Dialog>
    </ConfirmContext.Provider>
  );
}

/** Get the imperative confirm() — resolves true if the user confirms, false otherwise. */
export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm must be used within <ConfirmProvider>');
  return ctx;
}
