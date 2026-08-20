'use client';

import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * #346 — ONE error surface for a failed records query, used by every view.
 *
 * Before this, no view looked at the query error at all: table-view handled
 * `isLoading` and then rendered rows. A 422 and an empty database produced the
 * identical screen, so a rejected filter read as "all my data is gone". #345 was
 * one way to reject a filter; a deleted field, a saved view that stopped
 * validating after a schema change, a formula filter the compiler refuses, or the
 * API simply being down all land here too.
 *
 * The API is careful to distinguish "no matches" from "cannot answer" —
 * `records.service.ts` errors rather than returning an empty page precisely so a
 * caller cannot confuse the two. This component is where that distinction stopped
 * being honoured, so it exists to keep the two visually unmistakable.
 *
 * Deliberately one component rather than seven copies: the same defect has shipped
 * repeatedly in this codebase by way of a surface re-implementing what a shared one
 * already does (see the field-surfaces rules in CLAUDE.md).
 */

/**
 * The most useful sentence available about a failed query.
 *
 * The API's typed envelope (`{ error: { code, message, request_id } }`) is thrown
 * verbatim by `useRecordsInfinite`, and its `message` is usually the exact fix —
 * `op "has_none" on "status" expects a non-empty array of ids` tells you which
 * field and which operator. Discarding that and showing "Something went wrong"
 * would keep the user exactly as stuck as the silent empty grid did.
 */
export function queryErrorMessage(error: unknown): string | null {
  if (!error) return null;
  if (typeof error === 'string') return error.trim() || null;

  if (typeof error === 'object') {
    // The API envelope, thrown as-is by the query hooks.
    const envelope = (error as { error?: unknown }).error;
    if (envelope && typeof envelope === 'object') {
      const message = (envelope as { message?: unknown }).message;
      if (typeof message === 'string' && message.trim()) return message.trim();
    }
    // A bare { message } — and Error instances, whose `message` is an own-ish
    // property reachable the same way.
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message.trim();
  }
  return null;
}

/**
 * A filter is the overwhelmingly common cause, and it is the one the user can fix
 * themselves — so when we can tell, say so instead of leaving them to guess which
 * of their settings broke the view.
 */
export function looksLikeFilterError(error: unknown): boolean {
  const message = queryErrorMessage(error);
  if (!message) return false;
  return /\bfilter\b|\bop "|\boperator\b|not valid for|expects a non-empty/i.test(message);
}

export function ViewQueryError({
  error,
  onRetry,
  className,
}: {
  error: unknown;
  onRetry?: () => void;
  className?: string;
}) {
  const message = queryErrorMessage(error);
  const filterish = looksLikeFilterError(error);

  return (
    <div
      role="alert"
      data-testid="view-query-error"
      className={`flex flex-col items-center justify-center gap-3 px-6 py-12 text-center ${className ?? ''}`}
    >
      <AlertTriangle className="h-6 w-6 text-error" aria-hidden />
      <div className="space-y-1">
        <p className="text-sm font-medium text-ink">This view couldn&apos;t load.</p>
        {/* Never "no records": the whole point is that we do not know what is in
            here, and saying nothing is what made this look like data loss. */}
        <p className="max-w-md text-[13px] text-muted">
          {filterish
            ? 'Your records are safe — the filter on this view was rejected, so nothing could be fetched. Adjust or remove the filter condition to get the view back.'
            : 'Your records are safe — the request for them failed. This is not an empty database.'}
        </p>
        {message ? (
          <p className="mx-auto max-w-md break-words pt-1 font-mono text-[12px] text-error">{message}</p>
        ) : null}
      </div>
      {onRetry ? (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          Try again
        </Button>
      ) : null}
    </div>
  );
}
