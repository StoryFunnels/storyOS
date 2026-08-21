'use client';

import { Printer } from 'lucide-react';

/**
 * #262 — Print / Save as PDF.
 *
 * Deliberately `window.print()` and not a server-rendered PDF. The reported
 * complaint was that printing produced unusable output ("text is simply cut
 * through if it hits the margins"), and the cause was that this codebase had no
 * print stylesheet at all. Fixing the stylesheet fixes every route at once and
 * gives the reader their own browser's Save-as-PDF, page size and margins.
 *
 * A server-rendered PDF is still worth having — it is the only way to get
 * consistent output independent of the reader's browser, and the only way to
 * generate one without a human at the keyboard (an automation attaching a PDF).
 * That half of #262 stays open rather than being quietly declared done here.
 */
export function PrintAction() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      title="Print / Save as PDF"
      aria-label="Print or save as PDF"
      className="rounded p-1 text-faint hover:bg-hover hover:text-ink"
    >
      <Printer className="h-3.5 w-3.5" />
    </button>
  );
}
