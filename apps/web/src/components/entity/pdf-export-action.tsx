'use client';

import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FileText, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { API_URL, api } from '@/lib/api';
import { fallbackMessageForStatus } from '@/lib/http-error';
import { pdfExportErrorMessage, pdfFilename, unavailableReason, type PdfExportStatus } from '@/lib/pdf-export';
import { Tooltip } from '@/components/ui/tooltip';

/**
 * #876 — Export to PDF (the server-rendered half of #262), beside Print on a document.
 *
 * Three rules from the ticket, each of which has a failure it exists to prevent:
 *  - It asks `/capabilities` BEFORE offering the control and gates on `available`
 *    (reachability, not "configured"). Until the renderer's compose service ships, production
 *    has no renderer, so the control is shown disabled WITH the reason rather than as a button
 *    that answers 503 when pressed. It stays visible so the capability is discoverable.
 *  - While a render runs the control is busy and ignores further presses: a second press would
 *    queue a second render behind the first.
 *  - Every outcome ends in a file or a sentence — never a spinner that stops with nothing.
 */
export function PdfExportAction({ ws, doc, title }: { ws: string; doc: string; title: string }) {
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  const caps = useQuery({
    queryKey: ['capabilities'],
    queryFn: async (): Promise<PdfExportStatus> => {
      const { data, error } = await api.GET('/api/v1/capabilities');
      if (error || !data) throw error ?? new Error('no capabilities');
      return (data as { pdf_export: PdfExportStatus }).pdf_export;
    },
    staleTime: 20_000,
  });

  const available = caps.data?.available === true;
  const reason = caps.isPending
    ? 'Checking whether PDF export is available…'
    : caps.isError
      ? 'Could not check whether PDF export is available. Reload to try again.'
      : unavailableReason(caps.data);

  const run = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const res = await fetch(`${API_URL}/api/v1/workspaces/${ws}/documents/${doc}/export/pdf`, {
        credentials: 'include',
      });
      if (!res.ok) {
        let body: unknown;
        try {
          body = await res.json();
        } catch {
          body = undefined;
        }
        toast.error(body ? pdfExportErrorMessage(res.status, body) : fallbackMessageForStatus(res.status));
        // A refusal can mean the renderer just went away: re-read availability.
        void caps.refetch();
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = pdfFilename(res.headers.get('content-disposition'), title);
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      const skipped = Number(res.headers.get('x-storyos-export-skipped-images') ?? 0);
      toast.success(
        skipped > 0
          ? `PDF downloaded. ${skipped} image${skipped === 1 ? '' : 's'} could not be embedded and show as a placeholder.`
          : 'PDF downloaded',
      );
    } catch {
      toast.error('Could not reach StoryOS to make the PDF. Check your connection and try again.');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const onClick = () => {
    if (busy) return;
    if (!available) {
      // aria-disabled, not `disabled`: it stays focusable and tappable, so touch (no hover for the
      // tooltip) and keyboard users get the reason too.
      toast.message(reason);
      return;
    }
    void run();
  };

  const inactive = !available || busy;
  return (
    <Tooltip label={busy ? 'Making the PDF…' : available ? 'Export PDF' : reason}>
      <button
        type="button"
        onClick={onClick}
        aria-label={available ? 'Export as PDF' : `Export as PDF — unavailable. ${reason}`}
        aria-disabled={inactive}
        aria-busy={busy}
        className={
          inactive
            ? 'cursor-not-allowed rounded p-1 text-faint opacity-50'
            : 'rounded p-1 text-faint hover:bg-hover hover:text-ink'
        }
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileText className="h-3.5 w-3.5" />}
      </button>
    </Tooltip>
  );
}
