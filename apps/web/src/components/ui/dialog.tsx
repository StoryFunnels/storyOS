'use client';

import { BackLayer } from '@/lib/back-layers';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useRef } from 'react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export function DialogContent({
  title,
  children,
  className,
  unsaved,
}: {
  title: string;
  children: ReactNode;
  className?: string;
  /** #962 — this dialog is a form with a Save button: Back asks "Discard changes?" once anything in it has been
   *  typed or changed. Never set it on anything that autosaves. */
  unsaved?: boolean;
}) {
  const content = useRef<HTMLDivElement>(null);
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-[var(--z-dialog-backdrop)] bg-[var(--scrim)]" />
      <DialogPrimitive.Content
        ref={content}
        // #924 — pressing a toast's action (Undo) is not "clicking outside the dialog": the dialog stays.
        onInteractOutside={(e) => {
          if ((e.target as Element | null)?.closest?.('[data-sonner-toast]')) e.preventDefault();
        }}
        className={cn(
          'fixed left-1/2 top-1/2 z-[var(--z-dialog)] w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-[var(--radius-modal)] border border-border-default bg-card p-6 shadow-[var(--shadow-modal)]',
          className,
        )}
      >
        <BackLayer guard={unsaved ? content : undefined} />
        <DialogPrimitive.Title className="mb-4 text-base font-semibold text-ink">
          {title}
        </DialogPrimitive.Title>
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
