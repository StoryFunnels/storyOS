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
  const resolver = useRef<((value: boolean) => void) | null>(null);

  const confirm = useCallback<ConfirmFn>((options) => {
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
            <div className="flex justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => settle(false)}>
                {opts.cancelLabel ?? 'Cancel'}
              </Button>
              <Button
                variant={opts.danger ? 'destructive' : 'primary'}
                size="sm"
                autoFocus
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
