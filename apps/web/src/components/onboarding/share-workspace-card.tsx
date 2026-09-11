'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface RowResult {
  status: 'sending' | 'sent' | 'error';
  acceptUrl?: string;
  error?: string;
}

/**
 * #217 — the wizard's LAST step. Otto's ruling, verbatim: "the sequence is:
 * describe your work, land in something real, then share the thing you just
 * made" — inviting colleagues to an empty workspace invites them into an
 * empty room, and is the step most likely to be skipped and never returned
 * to. The copy changes with the sequence too: this is "share", not "invite".
 *
 * Loops the existing single-email `POST /invites` (#128) rather than adding a
 * bulk endpoint — one already exists per email, and a second way to create
 * the same invite row is exactly the drift `field-surfaces.md` warns about
 * for a different surface. Deliberately does NOT include a domain-auto-join
 * ("anyone @yourdomain can join") toggle: confirmed absent everywhere in the
 * codebase — no schema column, no accept-path support — while investigating
 * this ticket, and it is real new work (a workspace-level setting, an accept
 * path that does not require a named invite row, and a domain-ownership
 * question neither of those other pieces has to answer). Tracked as a
 * follow-up rather than folded in here by default.
 */
export function ShareWorkspaceCard({ ws, onDone }: { ws: string; onDone: () => void }) {
  const qc = useQueryClient();
  const [rows, setRows] = useState<string[]>(['']);
  const [results, setResults] = useState<Record<string, RowResult>>({});
  const [sending, setSending] = useState(false);

  const sendOne = useMutation({
    mutationFn: async (email: string) => {
      const { data, error } = await api.POST('/api/v1/workspaces/{ws}/invites', {
        params: { path: { ws } },
        body: { email, role: 'member' } as never,
      });
      if (error) throw error;
      return data as unknown as { accept_url: string };
    },
  });

  async function send() {
    const emails = Array.from(new Set(rows.map((r) => r.trim()).filter(Boolean)));
    if (emails.length === 0) return;
    setSending(true);
    setResults((prev) => {
      const next = { ...prev };
      for (const email of emails) next[email] = { status: 'sending' };
      return next;
    });
    await Promise.all(
      emails.map(async (email) => {
        try {
          const data = await sendOne.mutateAsync(email);
          setResults((prev) => ({ ...prev, [email]: { status: 'sent', acceptUrl: data.accept_url } }));
        } catch (err) {
          const message =
            (err as { error?: { message?: string } })?.error?.message ??
            (err as { message?: string })?.message ??
            'Could not send';
          setResults((prev) => ({ ...prev, [email]: { status: 'error', error: message } }));
        }
      }),
    );
    setSending(false);
    void qc.invalidateQueries({ queryKey: ['invites', ws] });
    void qc.invalidateQueries({ queryKey: ['onboarding', ws] });
  }

  const sentEntries = Object.entries(results).filter(([, r]) => r.status === 'sent');

  return (
    <div className="mb-6 rounded-[var(--radius-card)] border border-border-default bg-card p-4">
      <p className="text-[13px] font-medium text-ink">Share this with your team.</p>
      <p className="mt-1 text-[12px] text-muted">
        Invite the people who&rsquo;ll actually use this. You can always do this later from Settings →
        Members.
      </p>

      <div className="mt-3 flex flex-col gap-2">
        {rows.map((value, i) => {
          const result = results[value.trim()];
          return (
            <div key={i} className="flex items-center gap-2">
              <Input
                type="email"
                placeholder="name@company.com"
                value={value}
                disabled={sending}
                onChange={(e) =>
                  setRows((prev) => prev.map((r, idx) => (idx === i ? e.target.value : r)))
                }
              />
              {rows.length > 1 && (
                <button
                  type="button"
                  disabled={sending}
                  onClick={() => setRows((prev) => prev.filter((_, idx) => idx !== i))}
                  className="rounded p-1 text-muted hover:bg-hover hover:text-ink"
                  aria-label="Remove row"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
              {result?.status === 'sent' && (
                <span className="flex shrink-0 items-center gap-1 text-[12px] text-success">
                  <Check className="h-3.5 w-3.5" /> Sent
                </span>
              )}
              {result?.status === 'error' && (
                <span className="shrink-0 text-[12px] text-error">{result.error}</span>
              )}
            </div>
          );
        })}
      </div>

      <button
        type="button"
        disabled={sending}
        onClick={() => setRows((prev) => [...prev, ''])}
        className="mt-2 flex items-center gap-1 text-[12px] text-muted hover:text-ink"
      >
        <Plus className="h-3.5 w-3.5" /> Add another
      </button>

      {sentEntries.length > 0 && (
        <ul className="mt-3 flex flex-col gap-1.5" aria-label="Invite links">
          {sentEntries.map(([email, r]) => (
            <li key={email} className="flex items-center gap-2 text-[12px] text-muted">
              <span className="truncate">{email}</span>
              <button
                type="button"
                onClick={async () => {
                  await navigator.clipboard.writeText(r.acceptUrl!);
                  toast.success('Copied');
                }}
                className="flex shrink-0 items-center gap-1 text-faint hover:text-ink"
              >
                <Copy className="h-3 w-3" /> Copy link
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          disabled={sending || rows.every((r) => !r.trim())}
          onClick={() => void send()}
        >
          {sending ? 'Sending…' : 'Send invites'}
        </Button>
        <button type="button" onClick={onDone} className="text-[12px] text-muted hover:text-ink">
          {sentEntries.length > 0 ? 'Done' : 'Skip for now'}
        </button>
      </div>
    </div>
  );
}
