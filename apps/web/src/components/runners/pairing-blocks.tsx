'use client';

import { Copy } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { codeAriaLabel, displayCode } from '@/lib/runners/pairing';
import { COPY, NOT_PUBLISHED_YET } from '@/lib/runners/words';

/**
 * Ticket #1209: ONE copy control for everything copyable in "Add a Runner" (the command and the pairing code), so the two
 * cannot drift apart in look or in how they report success. `text` is exactly what lands on the clipboard. `font-sans` because
 * both call sites sit inside a `font-mono` box and a button's label must not inherit it (the first cut had Copy in two typefaces).
 */
export function CopyButton({ text, label }: { text: string; label: string }) {
  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      className="font-sans"
      aria-label={`Copy ${label}`}
      onClick={() => {
        navigator.clipboard.writeText(text).then(
          () => toast.success('Copied'),
          () => toast.error(`Could not copy. Select the ${label} and copy it.`),
        );
      }}
    >
      <Copy className="h-3 w-3" aria-hidden />
      Copy
    </Button>
  );
}

/** Step 1: the command, with Copy, and (until ticket #1140 clears) the one muted line for people the package is not on npm for yet. */
export function CommandBlock() {
  return (
    <>
      <div className="mt-1.5 flex h-[34px] max-w-[360px] items-center gap-2 rounded-[var(--radius-control)] border border-border-default bg-app pl-2.5 pr-1 font-mono text-[12px] text-ink">
        <span className="flex-1 overflow-x-auto whitespace-nowrap">{COPY.command}</span>
        <CopyButton text={COPY.command} label={COPY.command} />
      </div>
      <NotPublishedLine />
    </>
  );
}

/**
 * REMOVE WHEN ticket #1140 (publish @storyos/runner to npm) clears: delete this component, its one use in CommandBlock and
 * NOT_PUBLISHED_YET in words.ts. Nothing else refers to them.
 */
export function NotPublishedLine() {
  return (
    <p className="text-label text-muted" data-testid="not-published-line">
      {NOT_PUBLISHED_YET.before}{' '}
      <a href={NOT_PUBLISHED_YET.href} target="_blank" rel="noreferrer" className="text-primary-text underline">
        {NOT_PUBLISHED_YET.linkText}
      </a>
      .
    </p>
  );
}

/**
 * Step 2: the pairing code as ONE unbroken block (a real space invites typing or selecting it, ticket #1209). Letter-spacing
 * does the spacing; `select-all` makes a triple-click (or one click) select exactly the code; Copy puts the unspaced code on
 * the clipboard.
 */
export function PairingCode({ code }: { code: string }) {
  const shown = displayCode(code);
  return (
    <div className="mt-1.5 flex w-fit max-w-full items-center gap-2 rounded-[var(--radius-control)] border border-border-default bg-app py-1 pl-3 pr-1">
      <span
        className="select-all font-mono text-[22px] font-semibold leading-none tracking-[0.18em] text-ink sm:text-[26px]"
        aria-label={codeAriaLabel(code)}
        data-testid="pairing-code"
      >
        {shown}
      </span>
      <CopyButton text={shown} label="pairing code" />
    </div>
  );
}
